import type { MermaidConfig } from "mermaid";

// Mermaid derives colors internally and requires hex rather than CSS variables.
export function hexColor(value: string, backdrop = "#ffffff"): string {
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(
    value.trim(),
  );
  let channels: number[];
  let alpha = 1;
  if (hex) {
    const digits =
      hex[1].length <= 4
        ? [...hex[1]].map((digit) => digit.repeat(2)).join("")
        : hex[1];
    channels = [0, 2, 4].map((offset) =>
      parseInt(digits.slice(offset, offset + 2), 16),
    );
    if (digits.length === 8) alpha = parseInt(digits.slice(6), 16) / 255;
  } else {
    const rgb =
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
        value.trim(),
      );
    if (!rgb) return backdrop;
    channels = rgb.slice(1, 4).map(Number);
    alpha = Number(rgb[4] ?? 1);
  }
  alpha = Math.max(0, Math.min(1, alpha));
  return (
    "#" +
    channels
      .map((channel, index) => {
        const behind = parseInt(
          backdrop.slice(1 + index * 2, 3 + index * 2),
          16,
        );
        return Math.round(
          Math.max(0, Math.min(255, channel)) * alpha + behind * (1 - alpha),
        )
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

export function diagramTheme(
  style: CSSStyleDeclaration,
  classes: DOMTokenList,
) {
  function read(name: string): string {
    return style.getPropertyValue(`--vscode-${name}`).trim();
  }
  const background = hexColor(
    read("editor-background") || style.backgroundColor,
  );
  const foreground = hexColor(
    read("editor-foreground") || style.color,
    background,
  );
  const surface = hexColor(
    read("editorWidget-background") || read("sideBar-background"),
    background,
  );
  const secondary = hexColor(read("sideBar-background"), background);
  const border = hexColor(
    read("contrastBorder") || read("panel-border") || read("focusBorder"),
    foreground,
  );
  return {
    theme: "base",
    themeVariables: {
      darkMode:
        classes.contains("vscode-dark") ||
        classes.contains("vscode-high-contrast"),
      background,
      primaryColor: surface,
      primaryTextColor: foreground,
      primaryBorderColor: border,
      secondaryColor: secondary,
      secondaryTextColor: foreground,
      secondaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: foreground,
      tertiaryBorderColor: border,
      lineColor: foreground,
      textColor: foreground,
      mainBkg: surface,
      nodeBorder: border,
      nodeTextColor: foreground,
      clusterBkg: secondary,
      clusterBorder: border,
      defaultLinkColor: foreground,
      titleColor: foreground,
      edgeLabelBackground: background,
      actorBkg: surface,
      actorBorder: border,
      actorTextColor: foreground,
      actorLineColor: border,
      signalColor: foreground,
      signalTextColor: foreground,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: foreground,
      loopTextColor: foreground,
      activationBkgColor: secondary,
      activationBorderColor: border,
      noteBkgColor: surface,
      noteTextColor: foreground,
      noteBorderColor: border,
      fontFamily: read("font-family") || style.fontFamily,
      fontSize: read("font-size") || style.fontSize,
    },
  } satisfies MermaidConfig;
}
