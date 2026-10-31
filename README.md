# Listen 1 音乐播放器（桌面版）

源项目：[listen1_desktop](https://github.com/listen1/listen1_desktop)

## 修改如下：

1. 将原项目 listen1_chrome_extension，直接放到本项目。

2. 修复在无版权时候，直接停止播放问题。

3. 修复网易云、酷我无法播放问题。

4. 修复搜索无法展示内容问题。

5. 修复 README 中 `npm run dist:win32` / `npm run dist:win64` 无法执行的问题。

Listen 1 可以搜索和播放来自多个主流音乐网站的歌曲，让你的曲库更全面。并支持收藏功能，方便的创建自己的歌单。

## 支持音乐平台

- 网易云音乐
- QQ 音乐
- 酷狗音乐
- 酷我音乐
- bilibili
- 咪咕音乐
- 千千音乐

[![imgur](http://i.imgur.com/Ae6ItmA.png)]()

- 支持 Windows，Mac，Linux 平台

# 安装方式

访问 github 主页下载安装包安装

网址：https://github.com/jonathon1113/listen1_desktop/releases

## 生成完整代码

项目已直接包含 listen1_chrome_extension 的全部源码，checkout 后无需初始化子模块

    npm install

## 运行

    npm run start

## 在 Android 手机上使用（扩展版）

本项目同时提供 Electron 桌面版与 Chrome 扩展版两套形态，扩展版可直接在支持
Chrome 扩展的 Android 浏览器上运行（如 Kiwi Browser、Yandex Browser、Via 等）。

安装步骤：

1. 把 `app/listen1_chrome_extension` 整个目录复制到手机（数据线、网盘或局域网传输均可）。
2. 打开浏览器的扩展管理页，开启「开发者模式」。
3. 选择上一步的目录完成加载（选目录即可，无需打包成 zip）。
4. 点击工具栏的 Listen 1 图标，播放器界面会在新标签页打开。

已知限制（扩展形态的固有限制，与桌面版不同）：

- 播放由浏览器后台的 service worker 承担。浏览器在后台回收进程后播放会中断，
  需在系统里关闭对该浏览器的省电/后台清理策略。
- 播放器界面按桌面宽屏布局设计，手机竖屏下可用空间有限。
- 跨域请求依赖扩展的 `host_permissions` 与 `declarativeNetRequest` 规则。
  修改 `manifest.json` 或 `rules_1.json` 后，先跑一次静态校验：

      node scripts/validate_extension.js

## 生成安装包

全平台安装包（自动按当前操作系统选择目标）

    npm run dist

Windows 安装包

    npm run dist:win

`dist:win` 不带架构参数，会按 `package.json` 中 `build.win.target[].arch` 的配置一次产出
32 位（ia32）、64 位（x64）与 ARM64 三种安装包。

如果只需要其中一种（分别使用 `build/win32.yml` 与 `build/win64.yml`，只产出对应架构）：

    npm run dist:win32
    npm run dist:win64

> 说明：electron-builder 的 `--config` 是「整体替换」`package.json` 里的 `build` 字段，
> 而不是与之合并，因此 `build/win32.yml` 与 `build/win64.yml` 是完整配置副本。
> 修改 `package.json` 的 `build` 配置时，请同步更新这两个文件。

Windows 免安装目录版（不生成安装程序）

    npm run dist:win:dir

Mac 安装包

    npm run dist:mac

Linux 安装包

    npm run dist:linux
    npm run dist:linux32
    npm run dist:linux64
    npm run dist:linuxArm64
    npm run dist:linuxArmv7l
