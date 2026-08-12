import childProcess from "node:child_process";
import path from "node:path";
import util from "node:util";
import vscode from "vscode";

import { zigProvider } from "./zigSetup";

const execFile = util.promisify(childProcess.execFile);

type InitTemplate = "default" | "minimal";

interface InitTemplateItem extends vscode.QuickPickItem {
    template: InitTemplate;
}

const initTemplates: InitTemplateItem[] = [
    {
        label: "Default",
        description: "Recommended for most projects",
        detail: "A complete project for building an executable and a library with tests.",
        iconPath: new vscode.ThemeIcon("package"),
        template: "default",
    },
    {
        label: "Minimal",
        description: "Bare minimum project",
        detail: "A minimal project with only the essential files.",
        iconPath: new vscode.ThemeIcon("file-code"),
        template: "minimal",
    },
];

export async function createZigProject() {
    const template = await vscode.window.showQuickPick(initTemplates, {
        title: "Create Zig Project",
        placeHolder: "Choose a template",
    });
    if (!template) return;

    const zigPath = zigProvider.getZigPath();
    if (!zigPath) {
        void vscode.window.showErrorMessage("Cannot create a Zig project because Zig is not installed.");
        return;
    }

    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const projectDirectories = await vscode.window.showOpenDialog({
        title: "Select or create an empty directory for the Zig project",
        defaultUri,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Create Project Here",
    });
    if (!projectDirectories) return;

    const projectUri = projectDirectories[0];
    const projectName = path.basename(projectUri.fsPath);
    const directoryEntries = await vscode.workspace.fs.readDirectory(projectUri);
    if (directoryEntries.length > 0) {
        void vscode.window.showErrorMessage(`Cannot create Zig project: '${projectUri.fsPath}' is not empty.`);
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Creating Zig project '${projectName}'...`,
            },
            async () => {
                const args = template.template === "minimal" ? ["init", "--minimal"] : ["init"];
                await execFile(zigPath, args, { cwd: projectUri.fsPath });
            },
        );
    } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ".";
        void vscode.window.showErrorMessage(`Failed to create Zig project '${projectName}'${detail}`);
        return;
    }

    await vscode.commands.executeCommand("vscode.openFolder", projectUri, false);
}
