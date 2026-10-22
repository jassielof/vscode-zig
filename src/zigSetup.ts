import vscode from "vscode";

import fs from "fs/promises";
import path from "path";

import semver from "semver";

import * as minisign from "./minisign";
import * as versionManager from "./versionManager";
import * as zigUtil from "./zigUtil";
import { ZigProvider } from "./zigProvider";
import { snakeCase } from "lodash-es";

let statusItem: vscode.StatusBarItem;
let languageStatusItem: vscode.LanguageStatusItem;
let versionManagerConfig: versionManager.Config;
export let zigProvider: ZigProvider;

/** Removes the `zig.path` config option. */
async function installZig(context: vscode.ExtensionContext, temporaryVersion?: semver.SemVer) {
    let version = temporaryVersion;

    if (!version) {
        const wantedZig = await getWantedZigVersion(context, Object.values(WantedZigVersionSource));
        version = wantedZig?.version;
        if (wantedZig?.source === WantedZigVersionSource.workspaceBuildZigZon) {
            version = await findClosestSatisfyingZigVersion(context, wantedZig.version);
        }
    }

    if (!version) {
        // Lookup zig in $PATH
        const result = zigUtil.resolveExePathAndVersion("zig", "version");
        if ("exe" in result) {
            await vscode.workspace.getConfiguration("zig").update("path", undefined, true);
            zigProvider.set(result);
            return;
        }
    }

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (!version) {
        // Default to the latest tagged release
        version = (await getLatestTaggedZigVersion(context)) ?? undefined;
    }

    if (!version) {
        await zigProvider.setAndSave(null);
        return;
    }

    try {
        const exePath = await versionManager.install(versionManagerConfig, version);
        const zigConfig = vscode.workspace.getConfiguration("zig");
        await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
        zigProvider.set({ exe: exePath, version: version });
    } catch (err) {
        zigProvider.set(null);
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to install Zig ${version.toString()}: ${err.message}`);
        } else {
            void vscode.window.showErrorMessage(`Failed to install Zig ${version.toString()}!`);
        }
    }
}

async function findClosestSatisfyingZigVersion(
    context: vscode.ExtensionContext,
    version: semver.SemVer,
): Promise<semver.SemVer> {
    if (version.prerelease.length !== 0) return version;

    try {
        // We can't just return `version` because `0.12.0` should return `0.12.1`.
        const availableVersions = (await getVersions(context)).map((item) => item.version);
        const selectedVersion = semver.maxSatisfying(availableVersions, `^${version.toString()}`);
        return selectedVersion ?? version;
    } catch {
        return version;
    }
}

async function getLatestTaggedZigVersion(context: vscode.ExtensionContext): Promise<semver.SemVer | null> {
    try {
        const zigVersion = await getVersions(context);
        const latestTagged = zigVersion.find((item) => item.version.prerelease.length === 0);
        const result = latestTagged?.version ?? null;
        return result;
    } catch {
        return null;
    }
}

/**
 * Returns a sorted list of all versions that are provided by Zig's [index.json](https://ziglang.org/download/index.json) and Mach's [index.json](https://pkg.machengine.org/zig/index.json).
 *
 * Throws an exception when no network connection is available.
 */
async function getVersions(context: vscode.ExtensionContext): Promise<zigUtil.ZigVersion[]> {
    const result = await getVersionsCacheAware(context);
    if (result.cachedVersions) return result.cachedVersions;
    return await result.fetchedVersions;
}

async function getVersionsCacheAware(context: vscode.ExtensionContext): Promise<{
    cachedVersions: zigUtil.ZigVersion[] | null;
    /** Throws an exception when no network connection is available */
    fetchedVersions: Promise<zigUtil.ZigVersion[]>;
}> {
    const wantUpdate = await zigUtil.shouldCheckUpdate(context, "zig-version-list-last-update");

    let cached;
    if (wantUpdate) {
        await context.globalState.update("zig-version-list", undefined);
        cached = null;
    } else {
        cached = context.globalState.get<zigUtil.ZigVersion[]>("zig-version-list") ?? null;
        for (const entry of cached ?? []) {
            // Must be instanceof SemVer
            entry.version = new semver.SemVer(entry.version.raw);
        }
    }

    return {
        cachedVersions: cached,
        fetchedVersions: fetchIndexJson(context),
    };
}

/** Throws an exception when no network connection is available */
async function fetchIndexJson(context: vscode.ExtensionContext): Promise<zigUtil.ZigVersion[]> {
    /* Order from highest to lowest priority */
    const sources = ["https://ziglang.org/download/index.json", "https://pkg.machengine.org/zig/index.json"];
    const results = await Promise.all(
        sources.map(async (url) => {
            const response = await fetch(url);
            return response.json() as Promise<zigUtil.VersionIndex>;
        }),
    );
    // Flatten sources
    const indexJson = Object.assign({}, ...results) as zigUtil.VersionIndex;

    const result: zigUtil.ZigVersion[] = [];
    for (const [key, value] of Object.entries(indexJson)) {
        const name = key === "master" ? "nightly" : key;
        const version = new semver.SemVer(value.version ?? key);
        const targetName = `${getZigArchName(version)}-${zigUtil.getZigOSName()}`;
        const release = value[targetName];
        if (release) {
            result.push({
                name: name,
                version: version,
                url: release.tarball,
                sha: release.shasum,
                notes: value.notes,
                isMach: name.includes("mach"),
            });
        }
    }
    if (result.length === 0) {
        throw Error(
            `no pre-built Zig is available for your system '${zigUtil.getZigArchName("arm")}-${zigUtil.getZigOSName()}}', you can build it yourself using https://codeberg.org/ziglang/zig-bootstrap`,
        );
    }
    result.sort((lhs, rhs) => semver.compare(rhs.version, lhs.version));
    await context.globalState.update("zig-version-list", result);
    return result;
}

function getZigArchName(zigVersion: semver.SemVer): string {
    switch (zigVersion.compare(new semver.SemVer("0.15.0-dev.836+080ee25ec"))) {
        case -1:
        case 0:
            return zigUtil.getZigArchName("armv7a");
        case 1:
            return zigUtil.getZigArchName("arm");
    }
}

interface QuickPickItem extends vscode.QuickPickItem {
    onDidAccept?: () => Promise<void>;
}

async function selectVersionAndInstall(context: vscode.ExtensionContext) {
    const workspaceZig = await getWantedZigVersion(context, Object.values(WantedZigVersionSource));
    const zigInPath = zigUtil.resolveExePathAndVersion("zig", "version");

    const offlineVersions = await versionManager.query(versionManagerConfig);
    let onlineVersions: zigUtil.ZigVersion[] = [];

    function createItems(): QuickPickItem[] {
        const items: QuickPickItem[] = [];

        if (workspaceZig !== null) {
            const version = workspaceZig.version;
            const installed = offlineVersions.some((item) => semver.eq(item.version, version));
            items.push({
                label: "Use Workspace Version",
                detail: version.raw,
                description: installed ? "already installed" : undefined,
                onDidAccept: async () => {
                    await showUpdateWorkspaceVersionDialog(version, workspaceZig.source);
                    await installZig(context, version);
                },
            });
        }

        if (!("message" in zigInPath)) {
            items.push({
                label: "Use Zig in PATH",
                onDidAccept: async () => {
                    const zigConfig = vscode.workspace.getConfiguration("zig");
                    await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", "zig", true);
                },
            });
        }

        items.push(
            {
                label: "Manually Specify Path",
                onDidAccept: async () => {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        title: "Select Zig executable",
                    });
                    if (!uris) return;
                    await zigProvider.setAndSave(uris[0].fsPath);
                },
            },
            {
                label: "",
                kind: vscode.QuickPickItemKind.Separator,
            },
        );

        interface Version {
            label: string | null;
            version: semver.SemVer;
            /** Whether the version already installed in global extension storage */
            installed: boolean;
            /** Whether the version one of [Mach's nominated Zig versions](https://machengine.org/docs/nominated-zig/#nominated-zig-history)  */
            isMach: boolean;
        }

        const versions = offlineVersions.map<Version>((version) => ({
            label: null,
            version: version,
            installed: true,
            isMach: false, // We can't tell if a version is Mach while being offline
        }));

        outer: for (const item of onlineVersions) {
            const useName = item.version.prerelease.length !== 0;
            const name = useName ? item.name : null;
            for (const existing of versions) {
                if (!semver.eq(item.version, existing.version)) continue;
                existing.isMach = existing.isMach || item.isMach;
                existing.label = existing.label ?? name;
                continue outer;
            }
            versions.push({
                label: name,
                version: item.version,
                isMach: item.isMach,
                installed: false,
            });
        }

        versions.sort((lhs, rhs) => {
            // Mach versions except `mach-latest` move to the end
            if (lhs.label !== "mach-latest" && rhs.label !== "mach-latest" && lhs.isMach !== rhs.isMach)
                return +lhs.isMach - +rhs.isMach;
            return semver.compare(rhs.version, lhs.version);
        });

        let seenMachVersion = false;
        for (const item of versions) {
            if (item.isMach && !seenMachVersion && item.label !== "mach-latest") {
                seenMachVersion = true;
                items.push({
                    label: "Mach's Nominated Zig versions",
                    kind: vscode.QuickPickItemKind.Separator,
                });
            }

            items.push({
                label: item.label ?? item.version.raw,
                description: item.installed ? "already installed" : undefined,
                detail: item.label ? item.version.raw : undefined,
                onDidAccept: async () => {
                    await showUpdateWorkspaceVersionDialog(item.version, workspaceZig?.source);
                    await installZig(context, item.version);
                },
            });
        }
        return items;
    }

    const quickpick = vscode.window.createQuickPick<QuickPickItem>();
    quickpick.title = "Select Zig version to install";
    quickpick.matchOnDetail = true;

    quickpick.onDidAccept(async () => {
        if (!quickpick.activeItems.length) return;
        const selection = quickpick.activeItems[0];
        if (!selection.onDidAccept) return;
        quickpick.dispose();
        await selection.onDidAccept();
    });

    const result = await getVersionsCacheAware(context);
    if (result.cachedVersions) {
        onlineVersions = result.cachedVersions;
        quickpick.items = createItems();
        quickpick.show();
        return;
    }

    quickpick.busy = true;
    quickpick.placeholder = "Fetching available Zig versions...";
    quickpick.items = createItems();
    quickpick.show();

    try {
        onlineVersions = await result.fetchedVersions;
        quickpick.items = createItems();
        quickpick.placeholder = undefined;
    } catch (err) {
        quickpick.title = `${quickpick.title} (offline)`;
        quickpick.placeholder = "Failed to query available Zig versions";
        if (err instanceof Error) {
            void vscode.window.showErrorMessage(`Failed to query available Zig versions: ${err.message}`);
        } else {
            void vscode.window.showErrorMessage(`Failed to query available Zig versions!`);
        }
    } finally {
        quickpick.busy = false;
    }
}

async function showUpdateWorkspaceVersionDialog(
    version: semver.SemVer,
    source?: WantedZigVersionSource,
): Promise<void> {
    const workspace = getWorkspaceFolder();

    if (workspace !== null) {
        let buttonName;
        switch (source) {
            case WantedZigVersionSource.workspaceZigVersionFile:
                buttonName = "update .zigversion";
                break;
            case WantedZigVersionSource.workspaceBuildZigZon:
                buttonName = "update build.zig.zon";
                break;
            case WantedZigVersionSource.zigVersionConfigOption:
                buttonName = "update workspace settings";
                break;
            case undefined:
                buttonName = "create .zigversion";
                break;
        }

        const response = await vscode.window.showInformationMessage(
            `Would you like to save Zig ${version.toString()} in this workspace?`,
            buttonName,
        );
        if (!response) return;
    }

    source ??= workspace
        ? WantedZigVersionSource.workspaceZigVersionFile
        : WantedZigVersionSource.zigVersionConfigOption;

    switch (source) {
        case WantedZigVersionSource.workspaceZigVersionFile: {
            if (!workspace) throw new Error("failed to resolve workspace folder");

            const edit = new vscode.WorkspaceEdit();
            edit.createFile(vscode.Uri.joinPath(workspace.uri, ".zigversion"), {
                overwrite: true,
                contents: new Uint8Array(Buffer.from(version.raw)),
            });
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.workspaceBuildZigZon: {
            const metadata = await parseBuildZigZon();
            if (!metadata) throw new Error("failed to parse build.zig.zon");

            const edit = new vscode.WorkspaceEdit();
            edit.replace(metadata.document.uri, metadata.minimumZigVersionSourceRange, version.raw);
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.zigVersionConfigOption: {
            await vscode.workspace.getConfiguration("zig").update("version", version.raw, !workspace);
            break;
        }
    }
}

interface BuildZigZonMetadata {
    /** The `build.zig.zon` document. */
    document: vscode.TextDocument;
    minimumZigVersion: semver.SemVer;
    /** `.minimum_zig_version = "<start>0.13.0<end>"` */
    minimumZigVersionSourceRange: vscode.Range;
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | null {
    // Supporting multiple workspaces is significantly more complex so we just look for the first workspace.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0];
    }
    return null;
}

/**
 * Look for a `build.zig.zon` in the current workspace and return the `minimum_zig_version` in it.
 */
async function parseBuildZigZon(): Promise<BuildZigZonMetadata | null> {
    const workspace = getWorkspaceFolder();
    if (!workspace) return null;

    const manifestUri = vscode.Uri.joinPath(workspace.uri, "build.zig.zon");

    let manifest;
    try {
        manifest = await vscode.workspace.openTextDocument(manifestUri);
    } catch {
        return null;
    }
    // Not perfect, but good enough
    const regex = /\n\s*\.minimum_zig_version\s=\s"(.*)"/;
    const matches = regex.exec(manifest.getText());
    if (!matches) return null;

    const versionString = matches[1];
    const version = semver.parse(versionString);
    if (!version) return null;

    const startPosition = manifest.positionAt(matches.index + matches[0].length - versionString.length - 1);
    const endPosition = startPosition.translate(0, versionString.length);

    return {
        document: manifest,
        minimumZigVersion: version,
        minimumZigVersionSourceRange: new vscode.Range(startPosition, endPosition),
    };
}

/** The order of these enums defines the default order in which these sources are executed. */
enum WantedZigVersionSource {
    /** `.zigversion` */
    workspaceZigVersionFile = ".zigversion",
    /** The `minimum_zig_version` in `build.zig.zon` */
    workspaceBuildZigZon = "build.zig.zon",
    /** `zig.version` */
    zigVersionConfigOption = "zig.version",
}

/** Try to resolve the (workspace-specific) Zig version. */
async function getWantedZigVersion(
    context: vscode.ExtensionContext,
    /** List of "sources" that should are applied in the given order to resolve the wanted Zig version */
    sources: WantedZigVersionSource[],
): Promise<{
    version: semver.SemVer;
    source: WantedZigVersionSource;
} | null> {
    let workspace: vscode.WorkspaceFolder | null = null;
    // Supporting multiple workspaces is significantly more complex so we just look for the first workspace.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspace = vscode.workspace.workspaceFolders[0];
    }

    for (const source of sources) {
        let result: semver.SemVer | null = null;

        try {
            switch (source) {
                case WantedZigVersionSource.workspaceZigVersionFile:
                    if (workspace) {
                        const zigVersionString = await vscode.workspace.fs.readFile(
                            vscode.Uri.joinPath(workspace.uri, ".zigversion"),
                        );
                        result = semver.parse(zigVersionString.toString().trim());
                    }
                    break;
                case WantedZigVersionSource.workspaceBuildZigZon: {
                    const metadata = await parseBuildZigZon();
                    if (metadata?.minimumZigVersion) {
                        result = metadata.minimumZigVersion;
                    }
                    break;
                }
                case WantedZigVersionSource.zigVersionConfigOption: {
                    const versionString = vscode.workspace.getConfiguration("zig").get<string>("version");
                    if (versionString) {
                        result = semver.parse(versionString);
                        if (!result) {
                            void vscode.window.showErrorMessage(
                                `Invalid 'zig.version' config option. '${versionString}' is not a valid Zig version`,
                            );
                        }
                    }
                    break;
                }
            }
        } catch {}

        if (!result) continue;

        return {
            version: result,
            source: source,
        };
    }
    return null;
}

function updateStatusItem(item: vscode.StatusBarItem, version: semver.SemVer | null) {
    item.name = "Zig Version";
    item.text = version?.toString() ?? "not installed";
    item.tooltip = "Select Zig Version";
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
    if (version) {
        item.backgroundColor = undefined;
    } else {
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
}

function updateLanguageStatusItem(item: vscode.LanguageStatusItem, version: semver.SemVer | null) {
    item.name = "Zig";
    if (version) {
        item.text = `Zig ${version.toString()}`;
        item.detail = "Zig Version";
        item.severity = vscode.LanguageStatusSeverity.Information;
    } else {
        item.text = "Zig not installed";
        item.severity = vscode.LanguageStatusSeverity.Error;
    }
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
}

function updateEnvironmentVariableCollection(context: vscode.ExtensionContext) {
    const zigPath = zigProvider.getZigPath();
    if (zigPath) {
        const envValue = path.dirname(zigPath) + path.delimiter;
        // This will take priority over a user-defined PATH values.
        context.environmentVariableCollection.prepend("PATH", envValue);
    } else {
        context.environmentVariableCollection.delete("PATH");
    }

    const configuration = vscode.workspace.getConfiguration("zig");

    const zigLibPath = configuration.get<string>("libPath");
    if (zigLibPath) {
        context.environmentVariableCollection.replace("ZIG_LIB_DIR", zigLibPath);
    } else {
        context.environmentVariableCollection.delete("ZIG_LIB_DIR");
    }

    const errorStyle = configuration.get<string>("buildErrorStyle");
    if (errorStyle && errorStyle !== "verbose") {
        context.environmentVariableCollection.replace("ZIG_BUILD_ERROR_STYLE", snakeCase(errorStyle));
    } else {
        context.environmentVariableCollection.delete("ZIG_BUILD_ERROR_STYLE");
    }

    const multilineErrors = configuration.get<string>("buildMultilineErrors");
    if (multilineErrors && multilineErrors !== "indent") {
        context.environmentVariableCollection.replace("ZIG_BUILD_MULTILINE_ERRORS", snakeCase(multilineErrors));
    } else {
        context.environmentVariableCollection.delete("ZIG_BUILD_MULTILINE_ERRORS");
    }
}

/**
 * Should be called when one of the following events happen:
 * - The Zig executable has been modified
 * - A workspace configuration file has been modified (e.g. `.zigversion`, `build.zig.zon`)
 */
async function updateStatus(context: vscode.ExtensionContext): Promise<void> {
    const zigVersion = zigProvider.getZigVersion();
    const zigPath = zigProvider.getZigPath();

    updateStatusItem(statusItem, zigVersion);
    updateLanguageStatusItem(languageStatusItem, zigVersion);
    updateEnvironmentVariableCollection(context);

    // Try to check whether the Zig version satifies the `minimum_zig_version` in `build.zig.zon`

    if (!zigVersion || !zigPath) return;
    const buildZigZonMetadata = await parseBuildZigZon();
    if (!buildZigZonMetadata) return;
    if (semver.gte(zigVersion, buildZigZonMetadata.minimumZigVersion)) return;

    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

    void vscode.window
        .showWarningMessage(
            `Your Zig version '${zigVersion.toString()}' does not satisfy the minimum Zig version '${buildZigZonMetadata.minimumZigVersion.toString()}' of your project.`,
            "update Zig",
            "open build.zig.zon",
        )
        .then(async (response) => {
            switch (response) {
                case undefined:
                    break;
                case "update Zig": {
                    // This will source the desired Zig version with `getWantedZigVersion` which may not satisfy the minimum Zig version.
                    // This could happen for example when the a `.zigversion` specifies `0.12.0` but `minimum_zig_version` is `0.13.0`.
                    // The extension would install `0.12.0` and then complain again.
                    await installZig(context);
                    break;
                }
                case "open build.zig.zon": {
                    void vscode.window.showTextDocument(buildZigZonMetadata.document, {
                        selection: buildZigZonMetadata.minimumZigVersionSourceRange,
                    });
                    break;
                }
            }
        });
}

async function getMirrors(context: vscode.ExtensionContext): Promise<vscode.Uri[]> {
    const cacheKey = "zig-mirror-list";
    let cached = context.globalState.get(cacheKey, { timestamp: 0, mirrors: "" });

    const millisecondsInDay = 24 * 60 * 60 * 1000;
    if (new Date().getTime() - cached.timestamp > millisecondsInDay) {
        try {
            const response = await fetch("https://ziglang.org/download/community-mirrors.txt");
            if (response.status !== 200) throw Error("invalid mirrors");
            const mirrorList = await response.text();
            cached = {
                timestamp: new Date().getTime(),
                mirrors: mirrorList,
            };
            await context.globalState.update(cacheKey, cached);
        } catch {
            // Cannot fetch mirrors, rely on cache.
        }
    }

    return cached.mirrors
        .trim()
        .split("\n")
        .filter((u) => !!u)
        .map((u) => vscode.Uri.parse(u));
}

export async function setupZig(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // remove the `zig_install` directory from the global storage
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, "zig_install"), {
                recursive: true,
                useTrash: false,
            });
        } catch {}

        // remove a `zig.path` that points to the global storage.
        const zigConfig = vscode.workspace.getConfiguration("zig");
        const zigPath = zigConfig.get<string>("path", "");
        if (zigPath.startsWith(context.globalStorageUri.fsPath)) {
            await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
        }

        await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "initialSetupDone", undefined, true);

        await context.workspaceState.update("zig-version", undefined);

        // Remove incorrect values in the global state that have been added by
        // an older version of the extension.
        for (const key of context.globalState.keys()) {
            if (!key.startsWith("zig-satisfying-version-")) continue;
            const value = context.globalState.get(key);
            if (value !== undefined && typeof value !== "string") {
                await context.globalState.update(key, undefined);
            }
        }

        // convert `zig.buildOnSave` to `zig.buildOnSaveProvider`
        {
            const inspect = zigConfig.inspect("buildOnSave");
            if (inspect?.globalValue !== undefined) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveProvider", inspect.globalValue, true);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSave", undefined, true);
            }
            if (inspect?.workspaceValue !== undefined) {
                await zigUtil.workspaceConfigUpdateNoThrow(
                    zigConfig,
                    "buildOnSaveProvider",
                    inspect.workspaceValue,
                    false,
                );
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSave", undefined, false);
            }
        }

        // convert `zig.buildArgs` to `zig.buildOnSaveArgs`
        {
            const inspect = zigConfig.inspect("buildArgs");
            if (inspect?.globalValue) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveArgs", inspect.globalValue, true);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildArgs", undefined, true);
            }
            if (inspect?.workspaceValue) {
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildOnSaveArgs", inspect.workspaceValue, false);
                await zigUtil.workspaceConfigUpdateNoThrow(zigConfig, "buildArgs", undefined, false);
            }
        }
    }

    /// Workaround https://github.com/ziglang/zig/issues/21905
    switch (process.platform) {
        case "darwin":
        case "freebsd":
        case "openbsd":
        case "netbsd":
        case "haiku":
            vscode.workspace.onDidSaveTextDocument(async (document) => {
                if (document.languageId !== "zig") return;
                if (document.uri.scheme !== "file") return;

                const zigVersion = zigProvider.getZigVersion();
                if (!zigVersion) return;

                if (semver.gte(zigVersion, "0.15.0-dev.1372+abf179533")) return;

                const fsPath = document.uri.fsPath;
                try {
                    await fs.copyFile(fsPath, fsPath + ".tmp", fs.constants.COPYFILE_EXCL);
                    await fs.rename(fsPath + ".tmp", fsPath);
                } catch {}
            }, context.subscriptions);
            break;
        case "aix":
        case "android":
        case "linux":
        case "sunos":
        case "win32":
        case "cygwin":
            break;
    }

    versionManagerConfig = {
        context: context,
        title: "Zig",
        exeName: "zig",
        extraTarArgs: ["--strip-components=1"],
        /** https://ziglang.org/download */
        minisignKey: minisign.parseKey("RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"),
        versionArg: "version",
        getMirrorUrls() {
            return getMirrors(context);
        },
        canonicalUrl: {
            release: vscode.Uri.parse("https://ziglang.org/download"),
            nightly: vscode.Uri.parse("https://ziglang.org/builds"),
        },
        getArtifactName(version) {
            const fileExtension = process.platform === "win32" ? "zip" : "tar.xz";
            if (
                (version.prerelease.length === 0 && semver.gte(version, "0.14.1")) ||
                semver.gte(version, "0.15.0-dev.631+9a3540d61")
            ) {
                return `zig-${getZigArchName(version)}-${zigUtil.getZigOSName()}-${version.raw}.${fileExtension}`;
            } else {
                return `zig-${zigUtil.getZigOSName()}-${getZigArchName(version)}-${version.raw}.${fileExtension}`;
            }
        },
    };

    // Remove after some time has passed from the prefix change.
    await versionManager.convertOldInstallPrefixes(versionManagerConfig);

    zigProvider = new ZigProvider();

    /** There two status items because there doesn't seem to be a way to pin a language status item by default. */
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1);
    languageStatusItem = vscode.languages.createLanguageStatusItem("zig.status", { language: "zig" });

    context.environmentVariableCollection.description = "Add Zig to PATH";

    const watcher1 = vscode.workspace.createFileSystemWatcher("**/.zigversion");
    const watcher2 = vscode.workspace.createFileSystemWatcher("**/build.zig.zon");

    const refreshZigInstallation = zigUtil.asyncDebounce(async () => {
        if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
            await installZig(context);
        } else {
            await updateStatus(context);
        }
    }, 200);

    if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
        await installZig(context);
    }
    await updateStatus(context);

    const onDidChangeActiveTextEditor = (editor: vscode.TextEditor | undefined) => {
        if (editor?.document.languageId === "zig") {
            statusItem.show();
        } else {
            statusItem.hide();
        }
    };
    onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        statusItem,
        languageStatusItem,
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        vscode.workspace.onDidChangeConfiguration((change) => {
            if (change.affectsConfiguration("zig.version")) {
                void refreshZigInstallation();
            }
            if (change.affectsConfiguration("zig.path")) {
                const result = zigProvider.resolveZigPathConfigOption();
                if (result === undefined) return; // error message already reported
                if (result !== null) {
                    zigProvider.set(result);
                }
                void refreshZigInstallation();
            }
            if (
                change.affectsConfiguration("zig.libPath") ||
                change.affectsConfiguration("zig.buildErrorStyle") ||
                change.affectsConfiguration("zig.buildMultilineErrors")
            ) {
                updateEnvironmentVariableCollection(context);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        zigProvider.onChange.event(() => {
            void updateStatus(context);
        }),
        watcher1.onDidCreate(refreshZigInstallation),
        watcher1.onDidChange(refreshZigInstallation),
        watcher1.onDidDelete(refreshZigInstallation),
        watcher1,
        watcher2.onDidCreate(refreshZigInstallation),
        watcher2.onDidChange(refreshZigInstallation),
        watcher2.onDidDelete(refreshZigInstallation),
        watcher2,
    );
}
