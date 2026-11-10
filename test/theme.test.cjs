"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("Mermaid theme colors normalize hex/RGB and composite translucent VS Code colors", async () => {
  const { hexColor } = await import("../out/media/theme.mjs");
  assert.equal(hexColor("#abc"), "#aabbcc");
  assert.equal(hexColor("#112233"), "#112233");
  assert.equal(hexColor("#0008", "#ffffff"), "#777777");
  assert.equal(hexColor("#00000080", "#ffffff"), "#7f7f7f");
  assert.equal(hexColor("rgb(12, 34, 56)"), "#0c2238");
  assert.equal(hexColor("rgba(255, 255, 255, 0.5)", "#000000"), "#808080");
  assert.equal(hexColor("transparent", "#123456"), "#123456");
  assert.equal(hexColor("var(--unresolved)", "#123456"), "#123456");
});

test("diagram palettes use active theme variables for dark, light and high contrast", async () => {
  const { diagramTheme } = await import("../out/media/theme.mjs");
  const variables = {
    "editor-background": "#101820",
    "editor-foreground": "#eeeeee",
    "editorWidget-background": "#283038",
    "sideBar-background": "#182028",
    "panel-border": "#404850",
    focusBorder: "#ff0000",
    "font-family": "Test UI Font",
    "font-size": "13px",
  };
  const style = {
    getPropertyValue: (name) => variables[name.slice("--vscode-".length)] ?? "",
  };
  function classes(name) {
    return { contains: (value) => value === name };
  }
  for (const name of [
    "vscode-dark",
    "vscode-light",
    "vscode-high-contrast",
    "vscode-high-contrast-light",
  ]) {
    const theme = diagramTheme(style, classes(name));
    assert.equal(theme.theme, "base");
    assert.equal(
      theme.themeVariables.darkMode,
      ["vscode-dark", "vscode-high-contrast"].includes(name),
    );
    assert.equal(theme.themeVariables.primaryColor, "#283038");
    assert.equal(theme.themeVariables.primaryTextColor, "#eeeeee");
    assert.equal(theme.themeVariables.primaryBorderColor, "#404850");
    assert.equal(theme.themeVariables.actorBkg, "#283038");
    assert.equal(theme.themeVariables.signalColor, "#eeeeee");
    assert.equal(theme.themeVariables.fontFamily, "Test UI Font");
    assert.equal(theme.themeVariables.fontSize, "13px");
  }
  variables.contrastBorder = "#ffffff";
  assert.equal(
    diagramTheme(style, classes("vscode-high-contrast")).themeVariables
      .primaryBorderColor,
    "#ffffff",
  );
  variables["editorWidget-background"] = "#ffffff80";
  assert.equal(
    diagramTheme(style, classes("vscode-dark")).themeVariables.primaryColor,
    "#888c90",
  );
});

test("inline diff and UI styling use native theme tokens; fixed colors only define highlight hues", async () => {
  const css = await fs.readFile(
    path.join(__dirname, "..", "media", "suggest.css"),
    "utf8",
  );
  for (const line of css.split("\n"))
    if (/#[\da-f]{3,8}\b|\brgba?\(/i.test(line))
      assert.match(line, /^\s*--(?:hue-\d|covered):/, line);
  for (const name of [
    "diffEditor-insertedLineBackground",
    "diffEditor-removedLineBackground",
    "diffEditorGutter-insertedLineBackground",
    "diffEditorGutter-removedLineBackground",
    "editor-font-family",
    "contrastBorder",
    "focusBorder",
  ]) {
    assert.ok(css.includes(`--vscode-${name}`), `Theme token ${name}`);
  }
  assert.match(
    css,
    /body\.vscode-light,\s*body\.vscode-high-contrast-light\s*\{\s*color-scheme:\s*light;/,
  );
});
