import vscode from "vscode";

import { getZigToolchainSummary, removeInstalledZigVersions, selectVersionAndInstall } from "./zigSetup";
import { getZlsToolchainSummary, manageZlsToolchain } from "./zls";

export async function manageToolchains(context: vscode.ExtensionContext): Promise<void> {
    const selection = await vscode.window.showQuickPick(
        [
            {
                label: "$(tools) Zig compiler",
                description: getZigToolchainSummary(),
                detail: "Select, install, or use a custom Zig compiler",
                id: "zig-select",
            },
            {
                label: "$(server-process) Zig Language Server",
                description: getZlsToolchainSummary(),
                detail: "Use automatic compatibility, pin a version, or select a custom executable",
                id: "zls",
            },
            { label: "", kind: vscode.QuickPickItemKind.Separator, id: "separator" },
            {
                label: "$(trash) Remove managed Zig versions...",
                detail: "The active version is protected",
                id: "zig-remove",
            },
        ],
        { title: "Manage Zig Toolchains", placeHolder: "Choose a component or action" },
    );
    if (!selection) return;
    switch (selection.id) {
        case "zig-select":
            await selectVersionAndInstall(context);
            break;
        case "zls":
            await manageZlsToolchain();
            break;
        case "zig-remove":
            await removeInstalledZigVersions();
            break;
        case "separator":
            break;
    }
}
