const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");

async function start() {
  if (app.isPackaged) {
    // 打包形态：模板等只读资源在安装目录，可写数据在用户目录
    process.env.AMP_ROOT = path.join(process.resourcesPath, "app-root");
    process.env.AMP_DATA_DIR = path.join(app.getPath("userData"), "data");
    process.env.AMP_WORKSPACE_DIR = path.join(app.getPath("userData"), "workspace");
  } else {
    process.env.AMP_ROOT = path.join(__dirname, "..", "..");
  }

  const { startServer } = require("./dist/server.bundle.cjs");
  const { port } = await startServer({ port: 0 });

  const win = new BrowserWindow({
    width: 1380,
    height: 920,
    autoHideMenuBar: true,
    title: "自媒体内容工作台",
  });
  // 外链交给系统浏览器，应用内只承载工作台
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(() =>
  start().catch((err) => {
    dialog.showErrorBox("启动失败", String(err?.stack ?? err));
    app.quit();
  })
);
app.on("window-all-closed", () => app.quit());
