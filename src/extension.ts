import * as vscode from "vscode";
import { registerSuggestHost } from "./suggest-host.js";

export function activate(context: vscode.ExtensionContext): void {
  registerSuggestHost(vscode, context);
}
