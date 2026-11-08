// Runs inside a disposable VS Code window started by scripts/smoke.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const root = process.env.GUIDED_CODE_REVIEW_SMOKE_ROOT;
const port = process.env.GUIDED_CODE_REVIEW_SMOKE_PORT;

function trace(label, value) {
  return fs.appendFile(
    path.join(root, "smoke-trace.log"),
    `${label} ${value === undefined ? "" : JSON.stringify(value)}\n`,
  );
}

async function waitFor(task, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await task();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const contexts = new Set();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = message.id && pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
    if (message.method === "Runtime.executionContextCreated")
      contexts.add(message.params.context.id);
    if (message.method === "Runtime.executionContextDestroyed")
      contexts.delete(message.params.executionContextId);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      pending.set(current, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  }
  await call("Runtime.enable");
  return {
    contexts,
    close: () => socket.close(),
    async evaluate(expression, contextId) {
      const result = await call("Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value;
    },
  };
}

async function run() {
  assert.ok(root && path.basename(root) === "fixture");
  const clients = new Map();
  let page;
  try {
    trace("START", vscode.version);

    // Finds the suggest webview among all CDP targets and their frames.
    async function suggestContext(probe) {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      if (!response?.ok) return false;
      for (const target of await response.json()) {
        if (
          !target.webSocketDebuggerUrl ||
          !["page", "iframe"].includes(target.type)
        )
          continue;
        let client = clients.get(target.id);
        if (!client) {
          client = await connect(target.webSocketDebuggerUrl);
          clients.set(target.id, client);
        }
        for (const contextId of client.contexts) {
          const found = await client
            .evaluate(
              `Boolean(document.getElementById("suggestions") && (${probe}))`,
              contextId,
            )
            .catch(() => false);
          if (found) return { client, contextId };
        }
      }
      return false;
    }

    async function invokeTool(name, input) {
      let done = false;
      const pending = vscode.lm
        .invokeTool(name, { input, toolInvocationToken: undefined })
        .finally(() => {
          done = true;
        });
      // Only this disposable window can receive the confirmation clicks.
      await waitFor(async () => {
        if (done) return true;
        for (const client of clients.values())
          for (const contextId of client.contexts)
            await client
              .evaluate(
                `(() => { const dialog = document.querySelector('.monaco-dialog-box');
                  const button = dialog && [...dialog.querySelectorAll('button, [role="button"]')]
                    .find(node => /^(Allow|Allow Once|Continue|Run Tool)$/i.test(node.textContent.trim()));
                  if (button) button.click(); })()`,
                contextId,
              )
              .catch(() => {});
        return false;
      }, `tool ${name}`);
      const result = await pending;
      const text = result.content.find(
        (part) => part instanceof vscode.LanguageModelTextPart,
      ).value;
      trace(`TOOL ${name}`, text.slice(0, 400));
      return JSON.parse(text);
    }

    // 1. Open a session on the fixture notes, which contain a lone code fence.
    await waitFor(
      () =>
        vscode.lm.tools.some(
          (tool) => tool.name === "guidedReview_openSession",
        ),
      "layoutSuggest tools",
    );
    const notes = path.join(root, "notes.md");
    const { session } = await invokeTool("guidedReview_openSession", {
      path: notes,
    });

    // 2. Capture the changed line as a review-diff block, as the agent would.
    const capture = await invokeTool("guidedReview_captureCodeChanges", {
      session,
      files: [{ file: path.join(root, "lib.ts") }],
    });
    const block = { id: "lib-message", ...capture.files[0].block };
    const inspection = capture.files[0].inspection;
    assert.equal(inspection.boundaries.length, block.spans.length);
    assert.equal(inspection.boundaries[0].first.kind, "+");
    assert.equal(inspection.boundaries[0].first.text, "// changed");
    const workingLines = (
      await fs.readFile(path.join(root, "lib.ts"), "utf8")
    ).split("\n");
    assert.equal(
      inspection.boundaries[0].first.new,
      workingLines.indexOf("// changed") + 1,
    );
    assert.ok(
      inspection.preview[0].head.some((line) => line.text === "// changed"),
    );
    assert.equal(
      inspection.boundaries[0].following[0].text,
      'export type FileMode = "100644" | "100755" | null;',
    );

    // 3. A from/to suggestion whose span runs from before the lone fence to after it.
    const added = await invokeTool("guidedReview_addSuggestions", {
      session,
      suggestions: [
        {
          from: "The agent changes the document only through suggestions",
          to: "now in section 3), .vscode/mcp.json.",
          replacement:
            "- The agent changes the document only through suggestions.\n\n## 1. Library\n\nThe message changes.\n\n```review-diff\n" +
            JSON.stringify(block) +
            "\n```\n",
        },
      ],
    });
    const listed = await invokeTool("guidedReview_listSuggestions", {
      session,
    });
    const suggestion = listed.find?.((s) => s.from) ?? listed.suggestions?.[0];
    trace("CHECK suggestion", { added, suggestion });
    assert.ok(suggestion, "The suggestion is stored.");
    assert.deepEqual(
      suggestion.problems ?? [],
      [],
      "The host resolves both quotes.",
    );
    const id = suggestion.id;

    // 4. The page draws the suggestion's site and enables its jump button.
    page = await waitFor(
      () =>
        suggestContext(
          `document.querySelector('.card[data-id=${JSON.stringify(id)}]')`,
        ),
      "suggest view with the card",
    );
    const state = await page.client.evaluate(
      `(() => {
        const card = document.querySelector('.card[data-id=${JSON.stringify(id)}]');
        const doc = document.getElementById('document');
        return {
          site: doc.getElementsByClassName('site-${id}').length,
          jumpDisabled: card.querySelector('button.anchor').disabled,
          jumpText: card.querySelector('button.anchor').textContent,
          tokens: card.querySelectorAll('.syntax-token').length,
          codeHtml: [...card.querySelectorAll('.diff-line code')].map((code) => code.innerHTML.slice(0, 300)),
          lineBackgrounds: [...card.querySelectorAll('.diff-line')].map(
            (line) => line.className + ' ' + getComputedStyle(line).backgroundColor),
          diffVars: ['inserted', 'removed'].flatMap((kind) =>
            ['LineBackground', 'TextBackground'].map((part) => kind + part + '=' +
              getComputedStyle(document.documentElement).getPropertyValue('--vscode-diffEditor-' + kind + part))),
        };
      })()`,
      page.contextId,
    );
    trace("CHECK page", state);
    assert.ok(state.site > 0, "The document shows the suggestion's site.");
    assert.equal(
      state.jumpDisabled,
      false,
      "The jump button links to the site.",
    );
    assert.ok(
      state.tokens > 0,
      "The TypeScript diff is syntax highlighted on its first render.",
    );

    // Accept the first suggestion so its JSON fence becomes a rendered live diff.
    await page.client.evaluate(
      `document.querySelector('.card[data-id=${JSON.stringify(id)}] .actions button:last-child').click()`,
      page.contextId,
    );
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector('#document [data-block-id="lib-message"]'))`,
          page.contextId,
        ),
      "accepted live diff",
    );

    // File actions stay pinned; hunk locations belong directly above their own code.
    const sticky = await page.client.evaluate(
      `(async () => {
        const doc = document.getElementById('document');
        const block = doc.querySelector('.review-block');
        const header = block.querySelector('header');
        const hunk = block.querySelector('.hunk');
        const hunkTitle = hunk.querySelector('.hunk-title');
        const location = hunkTitle.querySelector('.diff-location');
        const savedScroll = doc.scrollTop;
        const added = Array.from({length: 100}, () => {
          const line = document.createElement('div');
          line.className = 'diff-line';
          line.textContent = 'long source line '.repeat(100);
          hunk.append(line);
          return line;
        });
        doc.scrollTop += block.getBoundingClientRect().top - doc.getBoundingClientRect().top + 150;
        await new Promise(requestAnimationFrame);
        const pinnedTop = header.getBoundingClientRect().top;
        const headerLeft = header.getBoundingClientRect().left;
        hunk.scrollLeft = 200;
        await new Promise(requestAnimationFrame);
        const result = {
          singleRow: [...header.querySelectorAll('strong, .diff-location > span, button')].every(element => {
            const rect = element.getBoundingClientRect();
            const head = header.getBoundingClientRect();
            return Math.abs(rect.top + rect.height / 2 - head.top - head.height / 2) < 2;
          }),
          grouped: !header.querySelector('.diff-location') && hunk.firstElementChild === hunkTitle && Boolean(location),
          patchHeader: hunkTitle.querySelector(':scope > span').textContent,
          pinned: Math.abs(pinnedTop - doc.getBoundingClientRect().top - parseFloat(getComputedStyle(doc).paddingTop)) < 2,
          horizontal: hunk.scrollLeft > 0,
          headerStayed: Math.abs(header.getBoundingClientRect().left - headerLeft) < 2,
          pinnedTop,
          docTop: doc.getBoundingClientRect().top,
          position: getComputedStyle(header).position,
          scrollTop: doc.scrollTop,
        };
        added.forEach(line => line.remove());
        hunk.scrollLeft = 0;
        doc.scrollTop = savedScroll;
        return result;
      })()`,
      page.contextId,
    );
    trace("CHECK sticky", sticky);
    assert.equal(sticky.singleRow, true);
    assert.equal(sticky.grouped, true);
    assert.match(sticky.patchHeader, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    assert.equal(sticky.pinned, true);
    assert.equal(sticky.horizontal, true);
    assert.equal(sticky.headerStayed, true);

    // Replace through the hidden JSON endpoint, and insert after the same fence.
    const followup = await invokeTool("guidedReview_addSuggestions", {
      session,
      suggestions: [
        {
          kind: "edit",
          from: "1. Library",
          to: JSON.stringify(block),
          replacement: "## 1. Start here\n\nFollow the entrypoint.\n",
        },
        {
          after: JSON.stringify(block),
          replacement: "Next, follow the session.",
        },
      ],
    });
    assert.equal(followup.rejected.length, 0);
    const [replaceId, insertId] = followup.added;
    const anchored = await waitFor(
      () =>
        page.client.evaluate(
          `(() => {
          const card = document.querySelector('.card[data-id="${replaceId}"]');
          const fence = document.querySelector('#document .anchor-block');
          if (!card || !fence?.classList.contains('site-${replaceId}')) return false;
          const insertion = document.querySelector('#document .insertion.site-${insertId}');
          const jump = card.querySelector('button.anchor');
          let scrolled = false;
          const first = document.querySelector('#document .site-${replaceId}');
          first.scrollIntoView = () => { scrolled = true; };
          jump.click();
          return {
            jumpDisabled: jump.disabled,
            scrolled,
            fenceLabel: getComputedStyle(fence, '::before').content,
            insertionAfterFence: fence.nextElementSibling === insertion,
            codeMarks: fence.querySelectorAll('mark').length,
            tokens: fence.querySelectorAll('.syntax-token').length,
          };
        })()`,
          page.contextId,
        ),
      "source-anchored markers",
    );
    trace("CHECK source anchors", anchored);
    assert.equal(anchored.jumpDisabled, false);
    assert.equal(
      anchored.scrolled,
      true,
      "The suggestion header jumps to its marked site.",
    );
    assert.ok(
      anchored.fenceLabel.includes(replaceId),
      "The fence has a visible suggestion marker.",
    );
    assert.equal(
      anchored.insertionAfterFence,
      true,
      "A JSON anchor inserts outside the rendered fence.",
    );
    assert.equal(
      anchored.codeMarks,
      0,
      "Prose decorations leave the code untouched.",
    );
    assert.ok(anchored.tokens > 0, "Anchoring preserves syntax highlighting.");

    // Approval and its record stay together when accepting an insertion after the JSON.
    await invokeTool("guidedReview_removeSuggestions", {
      session,
      ids: followup.added,
    });
    await page.client.evaluate(
      `document.querySelector('#document [data-action="approve"]').click()`,
      page.contextId,
    );
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector('#document button.reviewed'))`,
          page.contextId,
        ),
      "approved block",
    );
    const afterApproval = await invokeTool("guidedReview_addSuggestions", {
      session,
      suggestions: [
        {
          after: JSON.stringify(block),
          replacement: "After the approved record.",
        },
      ],
    });
    assert.equal(afterApproval.rejected.length, 0);
    const approvedInsertId = afterApproval.added[0];
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector('#document .anchor-block').nextElementSibling?.classList.contains('site-${approvedInsertId}'))`,
          page.contextId,
        ),
      "marker after approved pair",
    );
    await page.client.evaluate(
      `document.querySelector('.card[data-id="${approvedInsertId}"] .actions button:last-child').click()`,
      page.contextId,
    );
    await waitFor(
      async () =>
        (await fs.readFile(notes, "utf8")).includes(
          "After the approved record.",
        ),
      "accepted insertion",
    );
    const acceptedDocument = await fs.readFile(notes, "utf8");
    assert.match(acceptedDocument, /```\n```diff\n@@\n/);
    assert.ok(
      acceptedDocument.indexOf("After the approved record.") >
        acceptedDocument.lastIndexOf("```"),
    );

    // A single block has separate source/diff targets for changes in two functions.
    const navigationFile = path.join(root, "nav.ts");
    await vscode.workspace
      .getConfiguration("diffEditor")
      .update("renderSideBySide", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.openTextDocument(navigationFile);
    const symbols = await waitFor(
      () =>
        vscode.commands.executeCommand(
          "vscode.executeDocumentSymbolProvider",
          vscode.Uri.file(navigationFile),
        ),
      "TypeScript document symbols",
    );
    assert.ok(symbols.some((symbol) => symbol.name === "first"));
    const navCapture = await invokeTool("guidedReview_captureCodeChanges", {
      session,
      files: [
        { file: navigationFile, ranges: ["2"] },
        { file: navigationFile, ranges: ["old:26"] },
        { file: path.join(root, "gone.ts") },
        { file: path.join(root, "new.ts") },
      ],
    });
    for (const result of navCapture.files)
      assert.deepEqual(result.problems ?? [], []);
    const navRef = {
      id: "navigation",
      ...navCapture.files[0].block,
      spans: [
        ...navCapture.files[0].block.spans,
        ...navCapture.files[1].block.spans,
      ],
    };
    const deletedRef = { id: "deleted", ...navCapture.files[2].block };
    const addedRef = { id: "added", ...navCapture.files[3].block };
    const navSuggestion = await invokeTool("guidedReview_addSuggestions", {
      session,
      suggestions: [
        {
          replacement: `## Navigation\n\n\`\`\`review-diff\n${JSON.stringify(navRef)}\n\`\`\`\n\n\`\`\`review-diff\n${JSON.stringify(deletedRef)}\n\`\`\`\n\n\`\`\`review-diff\n${JSON.stringify(addedRef)}\n\`\`\``,
        },
      ],
    });
    assert.equal(navSuggestion.rejected.length, 0);
    const navSuggestionId = navSuggestion.added[0];
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector('.card[data-id="${navSuggestionId}"]'))`,
          page.contextId,
        ),
      "navigation suggestion",
    );
    await page.client.evaluate(
      `document.querySelector('.card[data-id="${navSuggestionId}"] .actions button:last-child').click()`,
      page.contextId,
    );
    const labels = await waitFor(
      () =>
        page.client.evaluate(
          `(() => {
        const rows = [...document.querySelectorAll('#document [data-block-id="navigation"] .diff-location')];
        return rows.length === 2 && rows.every(row => row.querySelector('button') && row.closest('.hunk') && !row.closest('header')) ? rows.map(row => row.textContent) : false;
      })()`,
          page.contextId,
        ),
      "separated navigation targets",
    );
    assert.match(labels[0], /first.*lines 2/);
    assert.match(labels[1], /second.*HEAD lines 26/);
    async function clickTarget(block, target, action) {
      await page.client.evaluate(
        `document.querySelectorAll('#document [data-block-id="${block}"] button[data-action="${action}"]')[${target}].click()`,
        page.contextId,
      );
    }
    await clickTarget("navigation", 0, "source");
    await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath ===
          navigationFile &&
        vscode.window.activeTextEditor.selection.start.line === 1,
      "first function source selection",
    );
    assert.equal(
      vscode.window.activeTextEditor.selection.end.character,
      '  const message = "new";'.length,
    );

    await clickTarget("navigation", 1, "diff");
    const removedEditor = await waitFor(
      () =>
        vscode.window.visibleTextEditors.find(
          (editor) =>
            editor.document.uri.scheme === "layout-suggest-git" &&
            editor.document.uri.path.endsWith("/nav.ts") &&
            editor.selection.start.line === 25,
        ),
      "deleted line on native diff's HEAD side",
    );
    assert.equal(
      removedEditor.document.getText(removedEditor.selection),
      "  const removed = 1;",
    );

    // Reusing the native comparison must select the new target, not the prior one.
    await clickTarget("navigation", 0, "diff");
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some(
          (editor) =>
            editor.document.uri.fsPath === navigationFile &&
            editor.document.getText(editor.selection) ===
              '  const message = "new";',
        ),
      "repeated native comparison selection",
    );

    // A fully deleted file opens its HEAD side; source reports an explicit error.
    await clickTarget("deleted", 0, "diff");
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some(
          (editor) =>
            editor.document.uri.scheme === "layout-suggest-git" &&
            editor.document.uri.path.endsWith("/gone.ts") &&
            editor.document.getText(editor.selection).includes("function gone"),
        ),
      "fully deleted file comparison",
    );
    await clickTarget("deleted", 0, "source");
    await waitFor(
      () =>
        page.client.evaluate(
          `document.getElementById('status').textContent.includes('file was deleted')`,
          page.contextId,
        ),
      "deleted source error",
    );

    // A new file compares against an empty HEAD side, not a missing Git blob.
    await clickTarget("added", 0, "diff");
    await waitFor(
      () =>
        vscode.window.visibleTextEditors.some(
          (editor) =>
            editor.document.uri.fsPath === path.join(root, "new.ts") &&
            editor.document.getText(editor.selection) ===
              "export const added = 1;",
        ),
      "new file comparison",
    );
    assert.ok(
      vscode.workspace.textDocuments.some(
        (doc) =>
          doc.uri.scheme === "layout-suggest-git" &&
          doc.uri.path === "/HEAD/new.ts" &&
          doc.getText() === "",
      ),
    );

    // Navigation survives approval and harmless movement, but stale buttons cannot guess.
    await page.client.evaluate(
      `document.querySelector('#document [data-block-id="navigation"] [data-action="approve"]').click()`,
      page.contextId,
    );
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector('#document [data-block-id="navigation"] button.reviewed'))`,
          page.contextId,
        ),
      "approved navigation",
    );
    const movedSource =
      "// moved\n" + (await fs.readFile(navigationFile, "utf8"));
    await fs.writeFile(navigationFile, movedSource);
    await waitFor(
      () =>
        vscode.workspace.textDocuments.some(
          (doc) =>
            doc.uri.fsPath === navigationFile && doc.getText() === movedSource,
        ),
      "working editor reload after movement",
    );
    await clickTarget("navigation", 0, "source");
    await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath ===
          navigationFile &&
        vscode.window.activeTextEditor.selection.start.line === 2,
      "re-resolved approved source selection",
    );
    await page.client.evaluate(
      `window.staleNavigation = document.querySelector('#document [data-block-id="navigation"]').cloneNode(true); true`,
      page.contextId,
    );
    await fs.writeFile(
      navigationFile,
      movedSource.replace('"new"', '"unrelated"'),
    );
    // Keep old rendered markup to exercise click-time validation despite watcher refreshes.
    await page.client.evaluate(
      `document.getElementById('document').append(window.staleNavigation);
       const staleButton = window.staleNavigation.querySelector('[data-action="source"]');
       staleButton.disabled = false;
       staleButton.click()`,
      page.contextId,
    );
    await waitFor(
      () =>
        page.client.evaluate(
          `document.getElementById('status').textContent.includes('original location is unavailable')`,
          page.contextId,
        ),
      "stale approved navigation error",
    );
    await page.client.evaluate(
      "window.staleNavigation.remove(); delete window.staleNavigation",
      page.contextId,
    );

    await fs.writeFile(
      path.join(root, "smoke-result.json"),
      JSON.stringify({ ok: true }),
    );
    trace("FINISHED");
  } catch (error) {
    await trace("FAILED", error.stack);
    await fs.writeFile(
      path.join(root, "smoke-result.json"),
      JSON.stringify({ ok: false, error: error.stack }),
    );
    throw error;
  } finally {
    for (const client of clients.values()) client.close();
  }
}

module.exports = { run };
