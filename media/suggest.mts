import type { Mermaid } from "mermaid";
import { diagramTheme } from "./theme.mjs";
import { diffText, findQuote, matchText } from "./match.mjs";
import type {
  AgentState,
  PageAction,
  PageMessage,
  RenderMessage,
  RequestMessage,
  SelectedText,
  StatusMessage,
  SuggestHostMessage,
  SuggestionView,
} from "../src/suggest-protocol.js";

interface VsCodeApi {
  setState(state: { session: string }): void;
  postMessage(message: PageMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function requiredElement<T extends HTMLElement = HTMLElement>(
  id: string,
  type?: new () => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof (type ?? HTMLElement)))
    throw new Error(`Missing required element: ${id}`);
  return element as T;
}

const documentView = requiredElement("document");
const suggestionsView = requiredElement("suggestions");
const statusView = requiredElement("status");
const promptForm = requiredElement("prompt", HTMLFormElement);
const promptText = requiredElement("prompt-text", HTMLInputElement);
const promptSend = requiredElement("prompt-send", HTMLButtonElement);
const selectionView = requiredElement("selection");
const selectionSource = requiredElement("selection-source");
const selectionText = requiredElement("selection-text");
const declinedView = requiredElement("declined");
const documentName = requiredElement("document-name");
const agentView = requiredElement("agent");

const vscode = acquireVsCodeApi();
const replies = new Map<number, (error: string | undefined) => void>();
let calls = 0;

const host = {
  /** Resolves with the host's error message, if the action failed. */
  send(message: PageAction): Promise<string | undefined> {
    const call = ++calls;
    return new Promise((resolve) => {
      replies.set(call, resolve);
      vscode.postMessage({ ...message, call });
    });
  },
  listen(listener: (message: RenderMessage | StatusMessage) => void): void {
    window.addEventListener(
      "message",
      (event: MessageEvent<SuggestHostMessage>) => {
        const message = event.data;
        if (message.type !== "reply") return listener(message);
        replies.get(message.call)?.(message.error);
        replies.delete(message.call);
      },
    );
    vscode.postMessage({ type: "ready" });
  },
};

interface TextIndex {
  text: string;
  nodes: (Text | HTMLElement)[];
  offsets: number[];
}

interface Decoration {
  start: number;
  end: number;
  classes: string[];
  label?: string;
}

function textIndex(root: Element, anchors = false): TextIndex {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        // A fence anchors by its Markdown source, not its generated code, buttons or SVG.
        if (node.parentElement?.closest(".anchor-block"))
          return NodeFilter.FILTER_REJECT;
        if (
          node instanceof HTMLElement &&
          node.classList.contains("anchor-block")
        )
          return anchors ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        return node instanceof Text
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  const index: TextIndex = { text: "", nodes: [], offsets: [] };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text || node instanceof HTMLElement)) continue;
    index.nodes.push(node);
    index.offsets.push(index.text.length);
    index.text +=
      node instanceof Text ? node.data : (node.dataset.anchorSource ?? "");
  }
  return index;
}

function decorate(index: TextIndex, decorations: Decoration[]): void {
  index.nodes.forEach((node, n) => {
    if (node instanceof HTMLElement) {
      const start = index.offsets[n];
      const end = start + (node.dataset.anchorSource?.length ?? 0);
      for (const decoration of decorations.filter(
        (d) => d.classes.includes("covered") && d.start < end && d.end > start,
      )) {
        node.classList.add(...decoration.classes);
        if (decoration.label) node.dataset.label = decoration.label;
      }
      return;
    }
    // Whitespace-only nodes sit between block elements, where a mark does not belong.
    if (!node.data.trim()) return;
    const nodeStart = index.offsets[n];
    const length = node.data.length;
    const relevant = decorations.filter(
      (d) => d.start < nodeStart + length && d.end > nodeStart,
    );
    if (!relevant.length) return;
    const cuts = new Set([0, length]);
    for (const d of relevant) {
      cuts.add(Math.max(0, d.start - nodeStart));
      cuts.add(Math.min(length, d.end - nodeStart));
    }
    const points = [...cuts].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let k = 0; k + 1 < points.length; k++) {
      const piece = node.data.slice(points[k], points[k + 1]);
      const at = nodeStart + points[k];
      const covering = relevant.filter((d) => d.start <= at && d.end > at);
      if (!covering.length) {
        fragment.append(piece);
        continue;
      }
      const mark = document.createElement("mark");
      mark.className = covering.flatMap((d) => d.classes).join(" ");
      const label = covering.find((d) => d.label && d.start === at)?.label;
      if (label) mark.dataset.label = label;
      mark.textContent = piece;
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  });
}

function card(
  suggestion: SuggestionView,
  fingerprint: string,
): { element: HTMLElement; replacement: HTMLElement; jump: HTMLButtonElement } {
  const element = document.createElement("article");
  const replaces = suggestion.from !== undefined;
  element.className = replaces ? `card ${suggestion.kind}` : "card insert";
  element.classList.toggle("selected", chosen === suggestion.id);
  element.dataset.id = suggestion.id;
  element.title = "Click to select it for the next request";
  element.addEventListener("click", (event) => {
    // Buttons act on their own; a click that ends a text selection is not a pick.
    if ((event.target as Element).closest("button") || sentId) return;
    if (document.getSelection()?.toString().trim()) return;
    chosen = chosen === suggestion.id ? undefined : suggestion.id;
    for (const other of suggestionsView.querySelectorAll<HTMLElement>(".card"))
      other.classList.toggle("selected", other.dataset.id === chosen);
  });
  const header = document.createElement("header");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = suggestion.id;
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "anchor";
  jump.title = "Show in the document";
  jump.textContent = replaces
    ? `${suggestion.kind === "edit" ? "Rewords" : "Replaces"} “${suggestion.from}” … “${suggestion.to}”`
    : suggestion.after !== undefined
      ? `Inserts after “${suggestion.after}”`
      : "Appends to the end";
  jump.addEventListener("click", () => showSite(suggestion.id));
  header.append(badge, jump);
  const replacement = document.createElement("div");
  replacement.className = "markdown replacement";
  replacement.innerHTML = suggestion.html; // Rendered by the server with Markdown HTML disabled.
  element.append(header, replacement);
  if (suggestion.problems.length) {
    const problems = document.createElement("ul");
    problems.className = "problems";
    for (const problem of suggestion.problems) {
      const item = document.createElement("li");
      item.textContent = problem;
      problems.append(item);
    }
    element.append(problems);
  }
  const accept = document.createElement("button");
  accept.textContent = "Accept";
  accept.disabled = suggestion.problems.length > 0;
  accept.addEventListener("click", async () => {
    accept.disabled = true;
    statusView.textContent = "Applying…";
    const error = await host
      .send({ type: "accept", id: suggestion.id, fingerprint })
      .catch((reason: unknown) => String(reason));
    statusView.textContent = error ?? "";
    if (error) accept.disabled = false;
  });
  const decline = document.createElement("button");
  decline.className = "secondary";
  decline.textContent = "Decline";
  decline.addEventListener("click", () => {
    declined.push(suggestion.id);
    if (chosen === suggestion.id) chosen = undefined;
    showDeclined();
    if (latest) queueRender(latest);
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(decline, accept);
  element.append(actions);
  return { element, replacement, jump };
}

const siteClass = (id: string) => `site-${id}`;

/** Scrolls the document to where a suggestion applies and flashes it. */
function showSite(id: string): void {
  const site = [...documentView.getElementsByClassName(siteClass(id))];
  site[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const element of site)
    element.animate(
      [
        { outlineColor: "var(--vscode-focusBorder)" },
        { outlineColor: "transparent" },
      ],
      { duration: 1500, easing: "ease-in" },
    );
}

/** Marks where an insertion lands: after its quote, or at the end of the document. */
function insertMarker(suggestion: SuggestionView): void {
  const marker = document.createElement("span");
  marker.className = `insertion ${siteClass(suggestion.id)}`;
  marker.dataset.label = suggestion.id;
  if (suggestion.after === undefined) {
    documentView.append(marker);
    return;
  }
  // Re-indexed per marker: decorations and earlier markers split text nodes.
  const index = textIndex(documentView, true);
  const found = findQuote(index.text, suggestion.after, 0);
  if (!found) return;
  let n = 0;
  while (n + 1 < index.nodes.length && index.offsets[n + 1] < found[1]) n++;
  const node = index.nodes[n];
  if (node instanceof Text) node.splitText(found[1] - index.offsets[n]);
  node.after(marker);
}

let mermaid: Mermaid | undefined;
let chartId = 0;
let revision = 0;
let latest: RenderMessage | undefined;
let pending: RenderMessage | undefined;
let rendering = false;
// Hidden locally until the agent picks up a request carrying them.
let declined: string[] = [];
// The card the reader picked for the next request; none by default.
let chosen: string | undefined;

function showDeclined(): void {
  declinedView.replaceChildren(
    ...declined.map((id) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "pill";
      pill.textContent = `${id} declined ×`;
      pill.title = "Restore this suggestion";
      pill.addEventListener("click", () => {
        declined = declined.filter((d) => d !== id);
        showDeclined();
        if (latest) queueRender(latest);
      });
      return pill;
    }),
  );
}

async function diagrams(currentRevision: number): Promise<void> {
  const nodes = [...document.querySelectorAll<HTMLElement>(".mermaid-source")];
  if (!nodes.length) return;
  try {
    if (!mermaid) {
      const url = requiredElement("client").dataset.mermaid;
      if (!url) throw new Error("Missing Mermaid resource URL");
      mermaid = ((await import(url)) as { default: Mermaid }).default;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      ...diagramTheme(getComputedStyle(document.body), document.body.classList),
      maxTextSize: 20000,
      maxEdges: 200,
      secure: [
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "themeCSS",
        "fontFamily",
        "themeVariables",
      ],
    });
    for (const node of nodes) {
      if (revision !== currentRevision) return;
      const source = node.textContent ?? "";
      // Documents supply diagram syntax, not renderer configuration.
      if (/%%\s*\{/.test(source) || /^\s*---/.test(source)) {
        node.textContent =
          "Diagram configuration directives are disabled.\n\n" + source;
        continue;
      }
      try {
        const { svg } = await mermaid.render(
          `layout-suggest-diagram-${++chartId}`,
          source,
        );
        if (revision !== currentRevision) return;
        const wrapper = document.createElement("div");
        wrapper.className = "diagram";
        wrapper.innerHTML = svg; // Mermaid strict-mode sanitized output.
        node.replaceWith(wrapper);
      } catch {
        node.classList.add("diagram-error");
        node.textContent = "Unable to render diagram. Source:\n\n" + source;
      }
    }
  } catch {
    for (const node of nodes)
      node.textContent =
        "Mermaid could not load. Source:\n\n" + node.textContent;
  }
}

async function render(
  message: RenderMessage,
  currentRevision: number,
): Promise<void> {
  const scroll = [documentView.scrollTop, suggestionsView.scrollTop];
  vscode.setState({ session: message.session });
  documentName.textContent = message.path.split("/").pop() ?? "";
  documentName.title = message.path;
  documentView.innerHTML = message.document; // Rendered by the server with Markdown HTML disabled.
  // Declines of suggestions the agent removed meanwhile are moot.
  declined = declined.filter((id) =>
    message.suggestions.some((s) => s.id === id),
  );
  showDeclined();
  if (chosen && !message.suggestions.some((s) => s.id === chosen))
    chosen = undefined;
  const suggestions = message.suggestions.filter(
    (s) => !declined.includes(s.id),
  );
  const cards = suggestions.map((s) => card(s, message.fingerprint));
  if (cards.length)
    suggestionsView.replaceChildren(...cards.map((c) => c.element));
  else {
    const ok = document.createElement("p");
    ok.className = "ok";
    ok.textContent = "OK";
    suggestionsView.replaceChildren(ok);
  }

  const index = textIndex(documentView, true);
  const decorations: Decoration[] = [];
  let color = 0;
  suggestions.forEach((suggestion, i) => {
    const { from, to } = suggestion;
    if (suggestion.problems.length || from === undefined || to === undefined)
      return;
    const start = findQuote(index.text, from, 0);
    const end = start && findQuote(index.text, to, start[0], start[1]);
    if (!start || !end) return;
    decorations.push({
      start: start[0],
      end: end[1],
      classes: ["covered", siteClass(suggestion.id)],
      label: suggestion.id,
    });
    const cardIndex = textIndex(cards[i].replacement);
    const cardDecorations: Decoration[] = [];
    // Keep offsets stable, but do not compare fence metadata with replacement prose.
    const source = index.nodes
      .map((node, n) => {
        const text =
          node instanceof Text
            ? node.data
            : " ".repeat(node.dataset.anchorSource?.length ?? 0);
        const offset = index.offsets[n];
        return text.slice(
          Math.max(0, start[0] - offset),
          Math.max(0, Math.min(text.length, end[1] - offset)),
        );
      })
      .join("");
    if (suggestion.kind === "edit") {
      const diff = diffText(source, cardIndex.text);
      for (const [s, e] of diff.removed)
        decorations.push({
          start: start[0] + s,
          end: start[0] + e,
          classes: ["removed"],
        });
      for (const [s, e] of diff.added)
        cardDecorations.push({ start: s, end: e, classes: ["added"] });
      decorate(cardIndex, cardDecorations);
      return;
    }
    for (const match of matchText(source, cardIndex.text)) {
      const classes = ["match", `c${color++ % 8}`];
      decorations.push({
        start: start[0] + match.source[0],
        end: start[0] + match.source[1],
        classes,
      });
      cardDecorations.push({
        start: match.target[0],
        end: match.target[1],
        classes,
      });
    }
    decorate(cardIndex, cardDecorations);
  });
  decorate(index, decorations);
  for (const suggestion of suggestions)
    if (!suggestion.problems.length && suggestion.from === undefined)
      insertMarker(suggestion);
  suggestions.forEach((suggestion, i) => {
    cards[i].jump.disabled = !documentView.getElementsByClassName(
      siteClass(suggestion.id),
    ).length;
  });
  [documentView.scrollTop, suggestionsView.scrollTop] = scroll;
  await diagrams(currentRevision);
}

async function drain(): Promise<void> {
  if (rendering) return;
  rendering = true;
  try {
    // Mermaid's shared configuration must not race a newer render.
    while (pending) {
      const message = pending;
      const currentRevision = revision;
      pending = undefined;
      await render(message, currentRevision);
    }
  } finally {
    rendering = false;
  }
}

function queueRender(message: RenderMessage): void {
  latest = pending = message;
  revision++;
  void drain();
}

// VS Code changes body classes and variables with the theme; diagrams take hex colors, so they render again.
let themeSignature: string | undefined;
const themeObserver = new MutationObserver(() => {
  const signature = JSON.stringify(
    diagramTheme(getComputedStyle(document.body), document.body.classList),
  );
  if (signature === themeSignature) return;
  themeSignature = signature;
  if (latest) queueRender(latest);
});
for (const node of [document.body, document.documentElement])
  themeObserver.observe(node, {
    attributes: true,
    attributeFilter: ["class", "style", "data-vscode-theme-id"],
  });

documentView.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest("button[data-action]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  const block = button.closest<HTMLElement>("[data-block-id]")?.dataset;
  if (!block?.blockId) return;
  const action = button.dataset.action;
  let message: PageAction | undefined;
  if ((action === "source" || action === "diff") && button.dataset.target)
    message = {
      type: action,
      block: block.blockId,
      target: button.dataset.target,
    };
  if (action === "approve" && block.fingerprint)
    message = {
      type: "approve",
      block: block.blockId,
      fingerprint: block.fingerprint,
    };
  else if (action === "unapprove")
    message = { type: "unapprove", block: block.blockId };
  if (!message) return;
  button.disabled = true;
  statusView.textContent = action === "approve" ? "Staging…" : "";
  const error = await host.send(message);
  statusView.textContent = error ?? "";
  if (error || action === "source" || action === "diff")
    button.disabled = false;
});

// Kept after focus moves to the prompt field, which takes the page selection away.
let selected: SelectedText | undefined;

function showSelection(): void {
  selectionView.hidden = !selected;
  selectionSource.textContent = selected ? `${selected.source}:` : "";
  selectionText.textContent = selected?.text ?? "";
}

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const source = element?.closest("#document")
    ? "document"
    : element?.closest<HTMLElement>(".card")?.dataset.id;
  if (!selection || !source || sentId) return;
  const text = selection.toString().trim();
  // Clicking a card to pick it collapses the selection; keep the quoted text.
  if (!text && source !== "document") return;
  selected = text ? { text, source } : undefined;
  showSelection();
});

requiredElement("selection-clear").addEventListener("click", () => {
  if (sentId) return;
  selected = undefined;
  showSelection();
});

// Our request, kept with its prompt on the page until the agent picks it up.
let sentId: string | undefined;

function showPrompt(): void {
  promptText.readOnly = sentId !== undefined;
  promptSend.classList.toggle("waiting", sentId !== undefined);
  promptSend.title = sentId
    ? "Waiting for the agent to pick up the request"
    : "";
  promptSend.textContent = sentId
    ? "Cancel"
    : promptText.value.trim()
      ? "Send"
      : "Suggest";
}

const agentLabels: Record<AgentState, string> = {
  listening: "Agent listening",
  working: "Agent working",
  away: "No agent",
};
let agentTimer: ReturnType<typeof setTimeout> | undefined;

function showAgent({ agent, since }: StatusMessage): void {
  clearTimeout(agentTimer);
  const show = () => {
    agentView.dataset.state = agent;
    agentView.textContent = agentLabels[agent];
    agentView.title = `Since ${new Date(since).toLocaleTimeString()}`;
  };
  // Agents poll again right after a wait times out; only a lasting absence shows.
  if (agent === "away" && agentView.dataset.state === "listening")
    agentTimer = setTimeout(show, 3000);
  else show();
}

function applyStatus(status: StatusMessage): void {
  showAgent(status);
  const { pending } = status;
  if (pending && !sentId) {
    // Sent before a reload or from another tab.
    sentId = pending.id;
    promptText.value = pending.text ?? "";
    selected = pending.selection;
    showSelection();
    declined = [...new Set([...declined, ...(pending.declined ?? [])])];
    showDeclined();
    chosen = pending.selected;
    if (latest) queueRender(latest);
  }
  if (sentId && status.delivered === sentId) {
    sentId = undefined;
    promptText.value = "";
    selected = undefined;
    showSelection();
    chosen = undefined;
    if (latest) queueRender(latest);
    statusView.textContent = "The agent picked up the request.";
  }
  showPrompt();
}

promptText.addEventListener("input", showPrompt);

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  promptSend.disabled = true;
  if (sentId) {
    const id = sentId;
    const error = await host
      .send({ type: "cancel", id })
      .catch((reason: unknown) => String(reason));
    if (!error && sentId === id) sentId = undefined;
    statusView.textContent = error ?? "Request withdrawn.";
  } else {
    const id = crypto.randomUUID();
    // Set first: the status naming this id may arrive before the response.
    sentId = id;
    showPrompt();
    const text = promptText.value.trim();
    const message: RequestMessage = {
      type: "request",
      id,
      ...(text && { text }),
      ...(selected && { selection: selected }),
      ...(chosen && { selected: chosen }),
      ...(declined.length ? { declined: [...declined] } : {}),
    };
    const error = await host
      .send(message)
      .catch((reason: unknown) => String(reason));
    if (error) {
      if (sentId === id) sentId = undefined;
      statusView.textContent = error;
    }
  }
  promptSend.disabled = false;
  showPrompt();
});

requiredElement("open-document").addEventListener("click", async () => {
  const error = await host
    .send({ type: "open" })
    .catch((reason: unknown) => String(reason));
  if (error) statusView.textContent = error;
});

host.listen((message) =>
  message.type === "status" ? applyStatus(message) : queueRender(message),
);
