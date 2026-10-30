# Listen 1 音乐播放器（桌面版）

源项目：[listen1_desktop](https://github.com/listen1/listen1_desktop)


## 修改如下：
1. 将原项目listen1_chrome_extension，直接放到本项目。

2. 修复在无版权时候，直接停止播放问题。

3. 修复网易云、酷我无法播放问题。

4. 修复搜索无法展示内容问题。

   


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

## 生成安装包

全平台安装包

    npm run dist

Windows 安装包

    npm run dist:win32
    npm run dist:win64

Mac 安装包

    npm run dist:mac

Linux 安装包

    npm run dist:linux32
    npm run dist:linux64
