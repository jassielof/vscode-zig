import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import vscode from "vscode";

import { getWorkspaceFolder } from "./zigUtil";
import { zigProvider } from "./zigSetup";

const execFile = util.promisify(childProcess.execFile);

interface ZigBuildStep {
    name: string;
    description: string;
    isDefault: boolean;
}

interface ZigBuildStepQuickPickItem extends vscode.QuickPickItem {
    step: ZigBuildStep;
}

export function registerBuildStepsCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand("zig.buildStep", runBuildStep));
}

async function runBuildStep() {
    const zigPath = zigProvider.getZigPath();
    if (!zigPath) return;

    const workspaceFolder = await pickWorkspaceFolder();
    if (!workspaceFolder) return;

    const quickPick = vscode.window.createQuickPick<ZigBuildStepQuickPickItem>();
    quickPick.placeholder = "Loading steps...";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.busy = true;
    quickPick.show();

    let steps: ZigBuildStep[];
    try {
        steps = await getBuildSteps(zigPath, workspaceFolder.uri.fsPath);
    } catch (e) {
        quickPick.dispose();
        const message = e instanceof Error ? e.message : "Failed to run 'zig build --list-steps'.";
        void vscode.window.showErrorMessage(message);
        return;
    }

    if (steps.length === 0) {
        quickPick.dispose();
        void vscode.window.showInformationMessage("No Zig build steps were found.");
        return;
    }

    quickPick.items = steps.map((step) => ({
        label: step.isDefault ? `$(star-full) ${step.name}` : step.name,
        description: step.isDefault ? "default" : undefined,
        detail: step.description || undefined,
        step,
    }));
    quickPick.placeholder = "Select a Zig build step to run";
    quickPick.busy = false;

    const pick = await new Promise<ZigBuildStepQuickPickItem | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems[0] as ZigBuildStepQuickPickItem | undefined);
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
        });
    });
    quickPick.dispose();
    if (!pick) return;

    const task = new vscode.Task(
        { type: "zig" },
        workspaceFolder,
        `zig build ${pick.step.name}`,
        "zig",
        new vscode.ShellExecution(zigPath, ["build", pick.step.name], { cwd: workspaceFolder.uri.fsPath }),
        "zig",
    );
    task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
    task.presentationOptions.clear = true;
    await vscode.tasks.executeTask(task);
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return undefined;

    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
        const folder = getWorkspaceFolder(activeFile);
        if (folder && hasBuildFile(folder)) return folder;
    }

    const candidates = folders.filter(hasBuildFile);
    if (candidates.length === 0) {
        void vscode.window.showErrorMessage("No 'build.zig' file was found in the workspace.");
        return undefined;
    }
    if (candidates.length === 1) return candidates[0];

    return vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the workspace folder to build" });
}

function hasBuildFile(folder: vscode.WorkspaceFolder): boolean {
    return fs.existsSync(path.join(folder.uri.fsPath, "build.zig"));
}

async function getBuildSteps(zigPath: string, cwd: string): Promise<ZigBuildStep[]> {
    const { stdout } = await execFile(zigPath, ["build", "--list-steps"], { cwd });

    const steps: ZigBuildStep[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        steps.push(parseStepLine(line));
    }

    // The default step should be the first pick
    steps.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return steps;
}

/**
 * Parses a line of `zig build --list-steps` output, e.g.:
 * - `  install (default)            Copy build artifacts to prefix path`
 * - `  spaced step (default)        Spaced step description`
 * - `  check`                       (empty description)
 *
 * Step names may contain single spaces (invoked as `zig build "spaced step"`), so the name/description boundary is taken to be the first run of 2+ spaces instead of any whitespace.
 */
function parseStepLine(line: string): ZigBuildStep {
    const trimmed = line.replace(/^\s+/, "");
    const columnGap = /\s{2,}/.exec(trimmed);
    const namePart = columnGap ? trimmed.slice(0, columnGap.index) : trimmed;
    const description = columnGap ? trimmed.slice(columnGap.index + columnGap[0].length).trim() : "";

    const defaultMatch = /^(.*?)\s+\(default\)$/.exec(namePart);
    return {
        name: (defaultMatch ? defaultMatch[1] : namePart).trim(),
        description,
        isDefault: !!defaultMatch,
    };
}
