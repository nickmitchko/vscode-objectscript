import fs = require("fs");
import glob = require("glob");
import path = require("path");
import vscode = require("vscode");
import { AtelierAPI } from "../api";
import { config, documentContentProvider, FILESYSTEM_SCHEMA, fileSystemProvider } from "../extension";
import { DocumentContentProvider } from "../providers/DocumentContentProvider";
import { currentFile, CurrentFile, outputChannel } from "../utils";

async function compileFlags(): Promise<string> {
  const defaultFlags = config().compileFlags;
  return vscode.window.showInputBox({
    prompt: "Compilation flags",
    value: defaultFlags,
  });
}

async function importFile(file: CurrentFile): Promise<any> {
  const api = new AtelierAPI(file.uri);
  return api
    .putDoc(
      file.name,
      {
        content: modernToObjectScript(file.content).split(/\r?\n/),
        enc: false,
      },
      true,
    );
}

function updateOthers(others: string[]) {
  others.forEach((item) => {
    const uri = DocumentContentProvider.getUri(item);
    documentContentProvider.update(uri);
  });
}

async function loadChanges(files: CurrentFile[]): Promise<any> {
  const api = new AtelierAPI(files[0].uri);
  return Promise.all(
    files.map((file) =>
      api.getDoc(file.name)
        .then((data) => {
          const content = (data.result.content || []).join("\n");
          if (file.uri.scheme === "file") {
            fs.writeFileSync(file.fileName, content);
          } else if (file.uri.scheme === FILESYSTEM_SCHEMA) {
            fileSystemProvider.writeFile(file.uri, Buffer.from(content), { overwrite: true, create: false });
          }
        })
        .then(() => api.actionIndex([file.name]))
        .then((data) => data.result.content[0].others)
        .then(updateOthers),
    ),
  );
}

// performs various transpiling steps to ingest modernized data and convert to object script precompilation.
// Honestly, this needs to be done in an abstract syntax tree but who cares for thr initial testing of the concept.
// I will probably make this 
function modernToObjectScript(sourceData: string): string {
  if (sourceData.includes('[ syntax = modern') ) {
    // remove the initial syntax=modern variables
    let modifiedSource = sourceData.replace(/syntax = modern/g, '');
    // handle the implicit set syntax
    let modifiedSource = sourceData.replace(/\n\s*[^(SET)|(set)|(Set)]\w+\s*=\s*.*/g, function (x) {
        return x.replace(/\n\s*[^(SET)|(set)|(Set)]/g, function (c) {return c + " SET ";});
    });
    // handle the implicit class method syntax
    let modifiedSource = sourceData.replace(/\n\s*[^(DO)|(Do)|(do)|(\&sql)]\w+(\.\w+){0,1}\(.*\)/g, function (x) {
        return x.replace(/\n\s*[^(DO)|(Do)|(do)|(\&sql)]/g, function (c) {return c + " DO ";});
    });
    return modifiedSource;
  } else {
    return sourceData;
  }
}

async function compile(docs: CurrentFile[], flags?: string): Promise<any> {
  flags = flags || config("compileFlags");
  const api = new AtelierAPI(docs[0].uri);
  return api
    .actionCompile(docs.map((el) => el.name), flags)
    .then((data) => {
      const info = docs.length > 1 ? "" : `${docs[0].name}: `;
      if (data.status && data.status.errors && data.status.errors.length) {
        throw new Error(`${info}Compile error`);
      } else {
        vscode.window.showInformationMessage(`${info}Compile succeeded`, "Hide");
      }
      return docs;
    })
    .then(loadChanges)
    .catch((error: Error) => {
      outputChannel.appendLine(error.message);
      outputChannel.show(true);
      vscode.window.showErrorMessage(error.message, "Show details")
        .then((data) => {
          outputChannel.show(true);
        });
    });
}

export async function importAndCompile(askFLags = false): Promise<any> {
  const file = currentFile();
  if (!file) {
    return;
  }
  if (!config("conn").active) {
    return;
  }

  const defaultFlags = config().compileFlags;
  const flags = askFLags ? await compileFlags() : defaultFlags;
  return importFile(file).catch((error) => {
    // console.error(error);
  }).then(() => compile([file], flags));
}

// Compiles all files types in the namespace
export async function namespaceCompile(askFLags = false): Promise<any> {
  const api = new AtelierAPI();
  const fileTypes = ["*.CLS", "*.MAC", "*.INC", "*.BAS"];
  if (!config("conn").active) {
    throw new Error(`No Active Connection`);
  }
  const defaultFlags = config().compileFlags;
  const flags = askFLags ? await compileFlags() : defaultFlags;
  if (flags === undefined) {
    // User cancelled
    return;
  }
  vscode.window.withProgress(
    {
      cancellable: false,
      location: vscode.ProgressLocation.Notification,
      title: `Compiling Namespace: ${api.ns}`,
    },
    async () => {
      const data = await api.actionCompile(fileTypes, flags);
      if (data.status && data.status.errors && data.status.errors.length) {
        // console.error(data.status.summary);
        throw new Error(`Compiling Namespace: ${api.ns} Error`);
      } else {
        vscode.window.showInformationMessage(`Compiling Namespace: ${api.ns} Success`);
      }
      const file = currentFile();
      return loadChanges([file]);
    },
  );
}

function importFiles(files) {
  return Promise.all<CurrentFile>(
    files.map((file) =>
      vscode.workspace
        .openTextDocument(file)
        .then(currentFile)
        .then((curFile) =>
          importFile(curFile)
            .then((data) => {
              outputChannel.appendLine("Imported file: " + curFile.fileName);
              return curFile;
            }),
        ),
    ))
    .then(compile);
}

export async function importFolder(uri: vscode.Uri): Promise<any> {
  const folder = uri.fsPath;
  if (fs.lstatSync(folder).isFile()) {
    return importFiles([folder]);
  }
  glob(
    "*.{cls,inc,mac,int}",
    {
      cwd: folder,
      matchBase: true,
      nocase: true,
    },
    (error, files) => importFiles(
      files.map((name) => path.join(folder, name))),
  );
}
