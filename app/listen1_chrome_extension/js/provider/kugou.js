/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
/* global async getParameterByName isElectron forge axios cookieGet */

// 酷狗早期的开放接口已经全部下线：
//   m.kugou.com/app/i/getSongInfo.php?cmd=playInfo  恒定返回 status 1002
//   wwwapi.kugou.com/yy/index.php?r=play/getdata     恒定返回 20010 / 30020
// 旧实现正是依赖这两个接口取歌名、封面与播放地址，因此表现为：
// 搜索结果整条丢失、歌单没有歌名、歌词解析报错、播放静默失败。
// 本文件已整体迁移到目前仍然可用的接口：
//   搜索           songsearch.kugou.com/song_search_v2
//   歌单/专辑/歌手  mobilecdnbj.kugou.com/api/v3/*
//   播放地址        gateway.kugou.com/v5/url（Android 网关，需要签名 + 设备指纹）
//   歌词           krcs.kugou.com/search + lyrics.kugou.com/download

const KG_APPID = '1005';
const KG_CLIENTVER = '11430';
// Android 网关的签名盐值与服务端一致，修改后接口会返回 "err signature"。
const KG_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp';
// 用于计算 key（证明请求方掌握文件 hash），缺失时接口返回 "illegal key"。
const KG_SIGNKEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';
const KG_UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const KG_UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_3 like Mac OS X) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';

/**
 * 安全探测运行环境：单元测试等非浏览器环境没有 isElectron 全局。
 */
function kgIsElectron() {
  try {
    return typeof isElectron === 'function' && !!isElectron();
  } catch (e) {
    return false;
  }
}

/**
 * 桌面端（Electron）页面以 file:// 加载，酷狗各接口会把请求判定为第三方站点：
 * 自定义头（dfid / x-router）属于非简单头，会触发 CORS 预检并被拦掉，
 * 跨站响应里的 Set-Cookie 也不会进入 cookie jar。
 * 因此 Electron 下统一改用 Node 的 http/https 发起请求，保证请求头真实发出。
 * @param {string} url
 * @param {object} headers
 * @param {number} [depth] 重定向次数
 */
function kgNodeGet(url, headers, depth) {
  const http = require('http'); // eslint-disable-line
  const https = require('https'); // eslint-disable-line
  const redirectCount = depth || 0;
  return new Promise((resolve, reject) => {
    const agent = url.startsWith('http://') ? http : https;
    const req = agent.get(
      url,
      {
        headers,
        timeout: 20000,
      },
      (res) => {
        const status = res.statusCode;
        // m.kugou.com 的部分接口会 301 跳转，必须跟随，否则响应体为空。
        if (
          redirectCount < 5 &&
          [301, 302, 307, 308].indexOf(status) !== -1 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          kgNodeGet(next, headers, redirectCount + 1).then(resolve, reject);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let data = body;
          try {
            data = JSON.parse(body);
          } catch (e) {
            // 非 JSON 响应保持字符串原文
          }
          resolve({ status, data, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('酷狗接口请求超时'));
    });
  });
}

function kgPickUA(url) {
  if (
    url.indexOf('m.kugou.com') !== -1 ||
    url.indexOf('mobilecdnbj.kugou.com') !== -1
  ) {
    return KG_UA_MOBILE;
  }
  return KG_UA_PC;
}

function kgPickReferer(url) {
  if (
    url.indexOf('mobilecdnbj.kugou.com') !== -1 ||
    url.indexOf('m.kugou.com') !== -1
  ) {
    return 'https://m.kugou.com/';
  }
  if (url.indexOf('kugou.com') !== -1) {
    return 'https://www.kugou.com/';
  }
  return '';
}

/**
 * 统一请求入口：Electron 走 Node，浏览器扩展走 axios。
 * @param {string} url
 * @param {object} [headers]
 */
function kgRequest(url, headers) {
  const merged = Object.assign(
    {
      'User-Agent': kgPickUA(url),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    headers || {}
  );
  if (kgIsElectron()) {
    const referer = kgPickReferer(url);
    if (referer && !merged.Referer) {
      merged.Referer = referer;
    }
    return kgNodeGet(url, merged);
  }
  return axios.get(url, { headers: merged });
}

/**
 * 计算 md5。Electron 下用 Node crypto，浏览器扩展下用页面引入的 forge。
 * @param {string} text
 * @returns {string|null}
 */
function kgMd5(text) {
  const value = String(text);
  if (kgIsElectron()) {
    const crypto = require('crypto'); // eslint-disable-line
    return crypto.createHash('md5').update(value, 'utf8').digest('hex');
  }
  if (typeof forge !== 'undefined' && forge.md5) {
    return forge.md5
      .create()
      .update(forge.util.encodeUtf8(value))
      .digest()
      .toHex();
  }
  return null;
}

/**
 * 酷狗 Android 网关签名：参数按 key 升序拼成 "k=v" 串，前后各加一次盐值后取 md5。
 * @param {object} params
 * @returns {string|null}
 */
function kgSignParams(params) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');
  return kgMd5(`${KG_ANDROID_SALT}${sorted}${KG_ANDROID_SALT}`);
}

/**
 * 计算 key：证明请求方掌握文件 hash，服务端校验失败会返回 "illegal key"。
 * @param {string} hash
 * @param {string} mid
 * @param {number} [userid]
 * @returns {string|null}
 */
function kgSignKey(hash, mid, userid) {
  return kgMd5(`${hash}${KG_SIGNKEY_SALT}${KG_APPID}${mid}${userid || 0}`);
}

/**
 * 拼接查询串，顺序与签名时保持一致。
 * @param {object} params
 */
function kgBuildQuery(params) {
  return Object.keys(params)
    .map(
      (key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
    )
    .join('&');
}

/**
 * 酷狗图片地址里带有 {size} 占位符，需要替换成实际尺寸。
 * @param {string} url
 */
function kgFixImg(url) {
  if (!url) {
    return '';
  }
  return String(url).replace('{size}', '400');
}

/**
 * 歌词正文是 base64 编码的 utf8 文本。
 * @param {string} text
 */
function kgDecodeBase64(text) {
  if (!text) {
    return '';
  }
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(String(text), 'base64').toString('utf8');
    }
    return decodeURIComponent(escape(window.atob(String(text))));
  } catch (e) {
    return '';
  }
}

class kugou {
  static get kg_device_info() {
    return this._kg_device_info || null;
  }

  static set kg_device_info(value) {
    this._kg_device_info = value;
  }

  static get kg_device_promise() {
    return this._kg_device_promise || null;
  }

  static set kg_device_promise(value) {
    this._kg_device_promise = value;
  }

  /**
   * 酷狗要求请求携带设备指纹 kg_dfid（同时需要 kg_mid）。
   * 该指纹只由酷狗官网在首次访问时通过 Set-Cookie 下发，
   * Node 的 http/https 请求读不到 Set-Cookie（实测所有酷狗域名都不下发），
   * 因此桌面端交由主进程用隐藏窗口访问官网后从 cookie jar 读取。
   * @returns {Promise<{dfid: string, mid: string}|null>}
   */
  static kg_get_device_info() {
    if (this.kg_device_info && this.kg_device_info.dfid) {
      return Promise.resolve(this.kg_device_info);
    }
    if (this.kg_device_promise) {
      return this.kg_device_promise;
    }
    const promise = (async () => {
      let info = null;
      if (kgIsElectron()) {
        try {
          const { ipcRenderer } = require('electron'); // eslint-disable-line
          info = await ipcRenderer.invoke('kugou-device-info');
        } catch (e) {
          info = null;
        }
      }
      if (!info || !info.dfid) {
        // 浏览器扩展没有主进程，只能读取已经存在的 cookie。
        info = await kugou.kg_read_device_cookie();
      }
      if (info && info.dfid) {
        this.kg_device_info = info;
      }
      return info;
    })()
      .catch(() => null)
      .finally(() => {
        this.kg_device_promise = null;
      });
    this.kg_device_promise = promise;
    return promise;
  }

  /**
   * 没有主进程时的兜底：读取已经存在的酷狗 cookie。
   * @returns {Promise<{dfid: string, mid: string}|null>}
   */
  static kg_read_device_cookie() {
    return new Promise((resolve) => {
      try {
        cookieGet(
          { url: 'https://www.kugou.com/', name: 'kg_dfid' },
          (cookie) => {
            if (!cookie || !cookie.value) {
              resolve(null);
              return;
            }
            cookieGet(
              { url: 'https://www.kugou.com/', name: 'kg_mid' },
              (midCookie) => {
                resolve({
                  dfid: cookie.value,
                  mid:
                    midCookie && midCookie.value
                      ? midCookie.value
                      : kugou.kg_random_mid(),
                });
              }
            );
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * 酷狗允许 mid 与设备指纹不严格绑定，缺失时补一个随机值即可。
   */
  static kg_random_mid() {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 32; i += 1) {
      result += chars[Math.floor(Math.random() * 16)];
    }
    return result;
  }

  /**
   * 把搜索接口的歌曲转换成播放器认识的 track。
   */
  static kg_convert_song(song) {
    const track = {
      id: `kgtrack_${song.FileHash}`,
      title: song.SongName,
      artist: '',
      artist_id: '',
      album: song.AlbumName,
      album_id: `kgalbum_${song.AlbumID}`,
      source: 'kugou',
      source_url: `https://www.kugou.com/song/#hash=${song.FileHash}&album_id=${song.AlbumID}`,
      img_url: '',
      lyric_url: song.FileHash,
    };
    let singer_id = song.SingerId;
    let singer_name = song.SingerName;
    if (song.SingerId instanceof Array) {
      [singer_id] = singer_id;
      [singer_name] = singer_name.split('、');
    }
    track.artist = singer_name;
    track.artist_id = `kgartist_${singer_id}`;
    // 搜索结果自带封面，不需要再逐首请求详情接口。
    track.img_url = kgFixImg(song.Image || song.AlbumImage || '');
    return track;
  }

  /**
   * 把歌单/专辑/歌手接口返回的歌曲项转换成 track。
   * 这几个接口的字段名与搜索接口不同，且部分字段缺失，这里统一做兜底。
   * @param {object} item
   * @param {object} [extra] 所属专辑/歌手的元信息
   */
  static kg_convert_playlist_song(item, extra) {
    const hash = item.hash || item.FileHash || '';
    const albumId = item.album_id || item.albumid || 0;
    const filename = item.filename || '';
    const parts = filename.split('-');
    const artistFromName = parts.length > 1 ? parts[0].trim() : '';
    const titleFromName = parts.length > 1 ? parts[1].trim() : filename;
    let singerId = item.singerid || item.SingerId || 0;
    if (singerId instanceof Array) {
      [singerId] = singerId;
    }
    const cover =
      (item.trans_param && item.trans_param.union_cover) ||
      item.imgurl ||
      item.Image ||
      '';
    return {
      id: `kgtrack_${hash}`,
      title: item.songname || item.SongName || titleFromName,
      artist: item.singername || item.SingerName || artistFromName,
      artist_id: `kgartist_${singerId}`,
      album: (extra && extra.title) || item.album_name || item.albumname || '',
      album_id: `kgalbum_${albumId}`,
      source: 'kugou',
      source_url: `https://www.kugou.com/song/#hash=${hash}&album_id=${albumId}`,
      img_url: kgFixImg(cover),
      lyric_url: hash,
    };
  }

  /**
   * 搜索歌曲或歌单。
   */
  static search(url) {
    const keyword = getParameterByName('keywords', url);
    const curpage = getParameterByName('curpage', url);
    const searchType = getParameterByName('type', url);
    if (searchType === '1') {
      // 歌单搜索
      const target_url = `http://mobilecdnbj.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(
        keyword
      )}&pagesize=20&filter=0&page=${curpage}`;
      return {
        success: (fn) => {
          kgRequest(target_url)
            .then((response) => {
              const data =
                (response && response.data && response.data.data) || {};
              const info = data.info || [];
              const result = info.map((item) => ({
                id: `kgplaylist_${item.specialid}`,
                title: item.specialname,
                source: 'kugou',
                source_url:
                  'https://www.kugou.com/yy/special/single/{size}.html'.replace(
                    '{size}',
                    item.specialid
                  ),
                img_url: kgFixImg(item.imgurl),
                url: `kgplaylist_${item.specialid}`,
                author: item.nickname,
                count: item.songcount,
              }));
              return fn({
                result,
                total: data.total || 0,
                type: searchType,
              });
            })
            .catch(() =>
              fn({
                result: [],
                total: 0,
                type: searchType,
              })
            );
        },
      };
    }
    // 歌曲搜索
    const target_url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(
      keyword
    )}&page=${curpage}`;
    return {
      success: (fn) => {
        kgRequest(target_url)
          .then((response) => {
            const data =
              (response && response.data && response.data.data) || {};
            const lists = data.lists || [];
            const result = lists.map((item) => kugou.kg_convert_song(item));
            return fn({
              result,
              total: data.total || 0,
              type: searchType,
            });
          })
          .catch(() =>
            fn({
              result: [],
              total: 0,
              type: searchType,
            })
          );
      },
    };
  }

  /**
   * 歌单详情。
   */
  static kg_get_playlist(url) {
    const list_id = getParameterByName('list_id', url).split('_').pop();
    return {
      success: (fn) => {
        const info_url = `http://mobilecdnbj.kugou.com/api/v3/special/info?specialid=${list_id}`;
        kgRequest(info_url)
          .then((response) => {
            const data =
              (response && response.data && response.data.data) || {};
            const info = {
              cover_img_url: kgFixImg(data.imgurl),
              title: data.specialname,
              id: `kgplaylist_${data.specialid || list_id}`,
              source_url:
                'https://www.kugou.com/yy/special/single/{size}.html'.replace(
                  '{size}',
                  data.specialid || list_id
                ),
            };
            const song_url = `http://mobilecdnbj.kugou.com/api/v3/special/song?specialid=${list_id}&page=1&pagesize=100`;
            return kgRequest(song_url)
              .then((res) => {
                const songData = (res && res.data && res.data.data) || {};
                const tracks = (songData.info || []).map((item) =>
                  kugou.kg_convert_playlist_song(item, info)
                );
                return fn({ tracks, info });
              })
              .catch(() => fn({ tracks: [], info }));
          })
          .catch(() => fn({ tracks: [], info: null }));
      },
    };
  }

  /**
   * 歌手主页。
   */
  static kg_artist(url) {
    const artist_id = getParameterByName('list_id', url).split('_').pop();
    return {
      success: (fn) => {
        const info_url = `http://mobilecdnbj.kugou.com/api/v3/singer/info?singerid=${artist_id}`;
        kgRequest(info_url)
          .then((response) => {
            const data =
              (response && response.data && response.data.data) || {};
            const info = {
              cover_img_url: kgFixImg(data.imgurl),
              title: data.singername,
              id: `kgartist_${artist_id}`,
              source_url: 'https://www.kugou.com/singer/{id}.html'.replace(
                '{id}',
                artist_id
              ),
            };
            const song_url = `http://mobilecdnbj.kugou.com/api/v3/singer/song?singerid=${artist_id}&page=1&pagesize=100`;
            return kgRequest(song_url)
              .then((res) => {
                const songData = (res && res.data && res.data.data) || {};
                const tracks = (songData.info || []).map((item) =>
                  kugou.kg_convert_playlist_song(item, info)
                );
                return fn({ tracks, info });
              })
              .catch(() => fn({ tracks: [], info }));
          })
          .catch(() => fn({ tracks: [], info: null }));
      },
    };
  }

  /**
   * 专辑主页。
   */
  static kg_album(url) {
    const album_id = getParameterByName('list_id', url).split('_').pop();
    return {
      success: (fn) => {
        const info_url = `http://mobilecdnbj.kugou.com/api/v3/album/info?albumid=${album_id}`;
        kgRequest(info_url)
          .then((response) => {
            const data =
              (response && response.data && response.data.data) || {};
            const info = {
              cover_img_url: kgFixImg(data.imgurl),
              title: data.albumname,
              id: `kgalbum_${data.albumid || album_id}`,
              source_url: 'https://www.kugou.com/album/{id}.html'.replace(
                '{id}',
                data.albumid || album_id
              ),
            };
            const song_url = `http://mobilecdnbj.kugou.com/api/v3/album/song?albumid=${album_id}&page=1&pagesize=100`;
            return kgRequest(song_url)
              .then((res) => {
                const songData = (res && res.data && res.data.data) || {};
                const tracks = (songData.info || []).map((item) =>
                  kugou.kg_convert_playlist_song(item, info)
                );
                return fn({ tracks, info });
              })
              .catch(() => fn({ tracks: [], info }));
          })
          .catch(() => fn({ tracks: [], info: null }));
      },
    };
  }

  /**
   * 推荐歌单列表。
   */
  static show_playlist(url) {
    let offset = getParameterByName('offset', url);
    if (offset === undefined || offset === null) {
      offset = 0;
    }
    const page = offset / 30 + 1;
    const target_url = `https://m.kugou.com/plist/index&json=true&page=${page}`;
    return {
      success: (fn) => {
        kgRequest(target_url)
          .then((response) => {
            const plist =
              (response && response.data && response.data.plist) || {};
            const list = plist.list || {};
            const info = list.info || [];
            const result = info.map((item) => ({
              cover_img_url: kgFixImg(item.imgurl),
              title: item.specialname,
              id: `kgplaylist_${item.specialid}`,
              source_url:
                'https://www.kugou.com/yy/special/single/{size}.html'.replace(
                  '{size}',
                  item.specialid
                ),
            }));
            return fn({ result });
          })
          .catch(() => fn({ result: [] }));
      },
    };
  }

  /**
   * 组装播放地址接口的请求参数。
   * @param {string} hash
   * @param {{dfid: string, mid: string}} device
   */
  static kg_build_play_params(hash, device) {
    const clienttime = Math.floor(Date.now() / 1000);
    const mid = device.mid || kugou.kg_random_mid();
    const params = {
      dfid: device.dfid,
      mid,
      uuid: '-',
      appid: KG_APPID,
      clientver: KG_CLIENTVER,
      clienttime,
      album_id: 0,
      area_code: 1,
      hash: String(hash).toLowerCase(),
      ssa_flag: 'is_fromtrack',
      version: KG_CLIENTVER,
      page_id: 151369488,
      quality: 128,
      album_audio_id: 0,
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: '463467626,350369493,788954147',
      cdnBackup: 1,
      module: '',
    };
    // 计算顺序不能颠倒：signature 需要把 key 也算进去。
    params.key = kgSignKey(params.hash, mid, 0);
    params.signature = kgSignParams(params);
    return params;
  }

  /**
   * 播放地址接口要求的请求头，缺少 x-router 会拿不到可用的 CDN 地址。
   * @param {object} params
   */
  static kg_play_headers(params) {
    return {
      dfid: params.dfid,
      clienttime: String(params.clienttime),
      mid: params.mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      'x-router': 'trackercdn.kugou.com',
    };
  }

  /**
   * 获取歌曲的可播放地址。
   */
  static bootstrap_track(track, success, failure) {
    const hash = track.id.slice('kgtrack_'.length);
    kugou
      .kg_get_device_info()
      .then((device) => {
        if (!device || !device.dfid) {
          // 没有设备指纹时接口一定失败，必须回调 failure，否则界面会一直加载中。
          return failure({});
        }
        const params = kugou.kg_build_play_params(hash, device);
        const target_url = `https://gateway.kugou.com/v5/url?${kgBuildQuery(
          params
        )}`;
        return kgRequest(target_url, kugou.kg_play_headers(params))
          .then((response) => {
            const data = (response && response.data) || {};
            const playUrl =
              data.status === 1 &&
              Array.isArray(data.url) &&
              data.url.length > 0
                ? data.url[0]
                : '';
            if (!playUrl) {
              return failure({});
            }
            return success({
              // 酷狗返回的是 http 地址，统一升级为 https，避免被混合内容策略拦截。
              url: playUrl.replace(/^http:\/\//, 'https://'),
              bitrate: '128kbps',
              platform: 'kugou',
            });
          })
          .catch(() => failure({}));
      })
      .catch(() => failure({}));
  }

  /**
   * 歌词：先查歌词候选拿到 accesskey，再下载 base64 编码的正文。
   */
  static lyric(url) {
    const track_id = getParameterByName('track_id', url).split('_').pop();
    const search_url = `https://krcs.kugou.com/search?ver=1&man=yes&client=pc&keyword=&duration=&hash=${track_id}&encoding=utf8`;
    return {
      success: (fn) => {
        kgRequest(search_url)
          .then((response) => {
            const data = (response && response.data) || {};
            const candidates = data.candidates || [];
            if (candidates.length === 0) {
              return fn({ lyric: '' });
            }
            const candidate = candidates[0];
            const download_url = `https://lyrics.kugou.com/download?ver=1&client=pc&fmt=lrc&charset=utf8&accesskey=${candidate.accesskey}&id=${candidate.id}&encoding=utf8`;
            return kgRequest(download_url)
              .then((res) => {
                const lyricData = (res && res.data) || {};
                return fn({ lyric: kgDecodeBase64(lyricData.content) });
              })
              .catch(() => fn({ lyric: '' }));
          })
          .catch(() => fn({ lyric: '' }));
      },
    };
  }

  static parse_url(url) {
    let result;
    const match = /\/\/www.kugou.com\/yy\/special\/single\/([0-9]+).html/.exec(
      url
    );
    if (match != null) {
      const playlist_id = match[1];
      result = {
        type: 'playlist',
        id: `kgplaylist_${playlist_id}`,
      };
    }
    return {
      success: (fn) => {
        fn(result);
      },
    };
  }

  static get_playlist(url) {
    // eslint-disable-line no-unused-vars
    const list_id = getParameterByName('list_id', url).split('_')[0];
    switch (list_id) {
      case 'kgplaylist':
        return this.kg_get_playlist(url);
      case 'kgalbum':
        return this.kg_album(url);
      case 'kgartist':
        return this.kg_artist(url);
      default:
        return null;
    }
  }

  static get_playlist_filters() {
    return {
      success: (fn) => fn({ recommend: [], all: [] }),
    };
  }

  static get_user() {
    return {
      success: (fn) => fn({ status: 'fail', data: {} }),
    };
  }

  static get_login_url() {
    return `https://www.kugou.com`;
  }

  static logout() {}
}
