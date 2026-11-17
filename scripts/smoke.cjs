"use strict";

// Runs the installed VSIX in an isolated desktop VS Code instance and disposable
// Git fixture. No project source, user settings or existing workspace is changed.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { promisify } = require("node:util");
const { spawn } = require("node:child_process");
const execFile = promisify(require("node:child_process").execFile);
const project = path.resolve(__dirname, "..");

// Own only the disposable process tree, including children retaining its pipes.
function desktop(executable, args, options, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure;
    function terminate() {
      if (!child.pid) return;
      if (process.platform === "win32") {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const killer = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.on("error", () => {
          child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }
    function interrupted() {
      failure = new Error("Desktop smoke interrupted.");
      terminate();
    }
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const timer = setTimeout(() => {
      failure = new Error(
        `Desktop smoke exceeded ${timeout} ms; isolated process group terminated.`,
      );
      terminate();
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-2 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2 * 1024 * 1024);
    });
    function cleanup() {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      terminate();
    }
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (failure || code !== 0)
        reject(
          Object.assign(
            failure ?? new Error(`Desktop smoke exited ${code ?? signal}.`),
            { stdout, stderr },
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-smoke-"),
  );
  const root = path.join(temporary, "fixture");
  const user = path.join(temporary, "user");
  const extensions = path.join(temporary, "extensions");
  const executable =
    process.env.VSCODE_EXECUTABLE ??
    (process.platform === "darwin"
      ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
      : process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA ?? "",
            "Programs",
            "Microsoft VS Code",
            "Code.exe",
          )
        : "/usr/share/code/code");
  const cli =
    process.env.VSCODE_CLI ??
    (process.platform === "darwin"
      ? path.resolve(path.dirname(executable), "../Resources/app/bin/code")
      : path.join(
          path.dirname(executable),
          "bin",
          process.platform === "win32" ? "code.cmd" : "code",
        ));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: "",
  });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  try {
    await fs.mkdir(root);
    await fs.mkdir(path.join(user, "User"), { recursive: true });
    await fs.writeFile(
      path.join(user, "User", "settings.json"),
      JSON.stringify({
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "workbench.enableExperiments": false,
        "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
        "workbench.startupEditor": "none",
        "security.workspace.trust.enabled": false,
        "git.enabled": false,
        "workbench.colorTheme": process.env.SMOKE_THEME ?? "Dark+",
        "chat.disableAIFeatures": true,
      }),
    );
    // Fixture operations, including runtime capture, share one isolated environment.
    // The desktop retains its ordinary XDG configuration location for platform integration.
    const fixtureEnv = {
      ...env,
      XDG_CONFIG_HOME: path.join(temporary, "config"),
    };
    function git(...args) {
      return execFile("git", args, {
        cwd: root,
        env: fixtureEnv,
        timeout: 15000,
      });
    }
    await git("init", "-b", "main");
    await git("config", "core.autocrlf", "false");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(root, ".gitignore"), "notes.md\n");
    // A real source file makes the grammar do realistic work.
    const source = await fs.readFile(
      path.join(project, "src", "git.ts"),
      "utf8",
    );
    await fs.writeFile(path.join(root, "lib.ts"), source);
    const navigationSource = [
      "export function first() {",
      '  const message = "old";',
      "  return message;",
      "}",
      ...Array.from({ length: 20 }, (_, index) => `// gap ${index}`),
      "export function second() {",
      "  const removed = 1;",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(root, "nav.ts"), navigationSource);
    await fs.writeFile(
      path.join(root, "gone.ts"),
      "export function gone() {\n  return 1;\n}\n",
    );
    await git("add", ".");
    await git("commit", "-m", "fixture");
    await fs.writeFile(
      path.join(root, "lib.ts"),
      source.replace("export", "// changed\nexport"),
    );
    await fs.writeFile(
      path.join(root, "nav.ts"),
      navigationSource
        .replace('"old"', '"new"')
        .replace("  const removed = 1;\n", ""),
    );
    await fs.unlink(path.join(root, "gone.ts"));
    await fs.writeFile(path.join(root, "new.ts"), "export const added = 1;\n");
    // A lone fence, as left by an accepted suggestion that cut a block in half,
    // turns the rest of the document into one code block.
    await fs.writeFile(
      path.join(root, "notes.md"),
      "# Smoke\n\n- First point.\n- The agent changes the document only through suggestions, and waits for the reader's feedback.\n\n```\n\n## Old section\n\nFiles: `experiments/layout-suggest/` (the standalone server, now in section 3), `.vscode/mcp.json`.\n",
    );
    const pkg = JSON.parse(
      await fs.readFile(path.join(project, "package.json"), "utf8"),
    );
    const installArgs = [
      "--user-data-dir",
      user,
      "--extensions-dir",
      extensions,
      "--shared-data-dir",
      path.join(temporary, "shared"),
      "--install-extension",
      path.join(project, "dist", `${pkg.name}-${pkg.version}.vsix`),
      "--force",
    ];
    // The documented Windows CLI is a .cmd wrapper. Quote every fixed argument
    // and refuse shell expansion characters rather than guessing their meaning.
    const windows = process.platform === "win32";
    function quote(value) {
      if (/["%!\r\n]/.test(value))
        throw new Error(
          "Windows smoke paths cannot contain shell expansion characters.",
        );
      return `"${value}"`;
    }
    const install = await desktop(
      windows ? quote(cli) : cli,
      windows ? installArgs.map(quote) : installArgs,
      { env, ...(windows ? { shell: true } : {}) },
      30000,
    );
    console.log(install.stdout.trim());
    const installed = (await fs.readdir(extensions)).find((name) =>
      name.startsWith("misli-local.guided-code-review-"),
    );
    if (!installed)
      throw new Error(
        "Local VSIX was not installed in the disposable extension directory.",
      );
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const result = await desktop(
      executable,
      [
        "--user-data-dir",
        user,
        "--extensions-dir",
        extensions,
        "--shared-data-dir",
        path.join(temporary, "shared"),
        "--extensionDevelopmentPath",
        path.join(extensions, installed),
        "--extensionTestsPath",
        path.join(project, "test", "host-smoke.cjs"),
        `--remote-debugging-port=${port}`,
        "--skip-welcome",
        "--skip-release-notes",
        root,
      ],
      {
        env: {
          ...env,
          GUIDED_CODE_REVIEW_SMOKE_ROOT: root,
          GUIDED_CODE_REVIEW_SMOKE_PORT: String(port),
        },
      },
    );
    console.log(result.stdout);
    if (result.stderr) console.log(result.stderr);
    const report = JSON.parse(
      await fs.readFile(path.join(root, "smoke-result.json"), "utf8"),
    );
    const trace = await fs.readFile(path.join(root, "smoke-trace.log"), "utf8");
    console.log(
      trace
        .split("\n")
        .filter((line) => /FAIL|CHECK|FINISHED/.test(line))
        .join("\n"),
    );
    if (!report.ok) throw new Error(report.error);
    console.log("Guided Review desktop smoke test passed.");
  } catch (error) {
    console.error(error.stdout ?? "", error.stderr ?? "");
    const report = await fs
      .readFile(path.join(root, "smoke-result.json"), "utf8")
      .catch(() => "No smoke result was written.");
    console.error(report);
    console.error(
      await fs
        .readFile(path.join(root, "smoke-trace.log"), "utf8")
        .catch(() => "No smoke trace was written."),
    );
    for (const entry of await fs
      .readdir(path.join(user, "logs"), { recursive: true })
      .catch(() => [])) {
      if (entry.endsWith("exthost.log") || entry.endsWith("renderer.log")) {
        console.error(
          (await fs.readFile(path.join(user, "logs", entry), "utf8")).slice(
            -12000,
          ),
        );
      }
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { desktop };
