import vscode from "vscode";

import { activate as activateZls, deactivate as deactivateZls } from "./zls";
import ZigMainCodeLensProvider from "./zigMainCodeLens";
import ZigTestRunnerProvider from "./zigTestRunnerProvider";
import { createZigProject } from "./zigProject";
import { registerBuildOnSaveProvider } from "./zigBuildOnSaveProvider";
import { registerBuildStepsCommand } from "./zigBuildSteps";
import { registerDiagnosticsProvider } from "./zigDiagnosticsProvider";
import { registerDocumentFormatting } from "./zigFormat";
import { registerTerminalStateManagement } from "./terminalState";
import { setupZig } from "./zigSetup";

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        context.subscriptions.push(registerDiagnosticsProvider());
        context.subscriptions.push(registerBuildOnSaveProvider());
        context.subscriptions.push(registerDocumentFormatting());

        const testRunner = new ZigTestRunnerProvider();
        testRunner.activate(context.subscriptions);

        registerTerminalStateManagement();
        ZigMainCodeLensProvider.registerCommands(context);
        registerBuildStepsCommand(context);
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                { language: "zig", scheme: "file" },
                new ZigMainCodeLensProvider(),
            ),
            vscode.commands.registerCommand("zig.createProject", createZigProject),
            vscode.commands.registerCommand("zig.toggleMultilineStringLiteral", toggleMultilineStringLiteral),
            vscode.commands.registerCommand(
                "zig.insertLineBreakWithoutContinuation",
                insertLineBreakWithoutContinuation,
            ),
        );

        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
}

async function toggleMultilineStringLiteral() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const { document, selection } = editor;
    if (document.languageId !== "zig") return;

    let newText = "";
    let range = new vscode.Range(selection.start, selection.end);

    const firstLine = document.lineAt(selection.start.line);
    const nonWhitespaceIndex = firstLine.firstNonWhitespaceCharacterIndex;

    for (let lineNum = selection.start.line; lineNum <= selection.end.line; lineNum++) {
        const line = document.lineAt(lineNum);

        const isMLSL = line.text.slice(line.firstNonWhitespaceCharacterIndex).startsWith("\\\\");
        const breakpoint = Math.min(nonWhitespaceIndex, line.firstNonWhitespaceCharacterIndex);

        const newLine = isMLSL
            ? line.text.slice(0, line.firstNonWhitespaceCharacterIndex) +
              line.text.slice(line.firstNonWhitespaceCharacterIndex).slice(2)
            : line.isEmptyOrWhitespace
              ? " ".repeat(nonWhitespaceIndex) + "\\\\"
              : line.text.slice(0, breakpoint) + "\\\\" + line.text.slice(breakpoint);
        newText += newLine;
        if (lineNum < selection.end.line) newText += "\n";

        range = range.union(line.range);
    }

    await editor.edit((builder) => {
        builder.replace(range, newText);
    });
}

async function insertLineBreakWithoutContinuation() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const { document } = editor;

    await editor.edit((builder) => {
        for (const selection of editor.selections) {
            const line = document.lineAt(selection.active.line);
            const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
            builder.delete(selection);
            builder.insert(selection.active, "\n" + indent);
        }
    });
}
