// ==UserScript==
// @name         废文网 · 书签标记 & 云同步
// @namespace    didi.fw
// @version      1.4.2
// @description  章节标签(精彩/一般/跳过)+备注、书签(多个/手动/免命名)、整本书总评与自定义标签、阅读进度、目录/书列表/正文页内联角标、GitHub 私有仓库 + 坚果云 WebDAV 双备份同步
// @author       小喵
// @match        *://*.xn--pxtr7m5ny.com/*
// @match        *://*.xn--pxtr7m.com/*
// @match        *://*.xn--pxtr7m.net/*
// @match        *://*.xn--pxtr7m.link/*
// @match        *://*.sosad.fun/*
// @match        *://*.sosadfun.com/*
// @updateURL    https://raw.githubusercontent.com/voltage0045/fw-marks/main/fw-marks.meta.js
// @downloadURL  https://raw.githubusercontent.com/voltage0045/fw-marks/main/fw-marks.user.js
// @run-at       document-idle
// @inject-into  auto
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.xmlHttpRequest
// @connect      api.github.com
// @connect      dav.jianguoyun.com
// @noframes
// ==/UserScript==

/*
 * 换域名 / 加镜像站：在上面复制一行 @match 改成新域名即可。
 * 数据存在扩展存储里（不是网站的 localStorage，Safari 不会清掉）。
 *
 * 云端是「双备份」：GitHub 私有仓库 + 坚果云 WebDAV，两边都是鉴权存储。
 * 凭据（token / 应用密码）只存本机，snapshot() 白名单式上传，永远不会被传上去。
 * 同步一轮 = 两边都拉下来 → 和本地逐条比 updatedAt 取最新 → 合并结果推回两边。
 * 所以任何一边落后都会被自动补齐，任何一边挂了另一边照样能用。
 */

(async function () {
  'use strict';
  if (window.top !== window.self) return;

  /*
   * 防重复注入。
   * 装两份是很容易发生的：本地文件放了一份，又用 Userscripts 的
   * 「New Remote」按链接加了一份 —— 两边都会跑，结果顶栏两个入口、
   * 每章两条标记条、事件监听全翻倍。
   * 标记打在 documentElement 上（而不是 window 变量）：注入上下文可能是
   * 隔离世界，window 彼此看不见，但 DOM 是共享的；而且这一步是同步的，
   * 不会出现「两份都还没建好就都通过检查」的竞态。
   */
  if (document.documentElement.dataset.fwMarksLoaded) return;
  document.documentElement.dataset.fwMarksLoaded = '1';

  const MARKS = {
    good: { label: '精彩', color: '#e8554e' },
    ok:   { label: '一般', color: '#6b8fd4' },
    skip: { label: '跳过', color: '#9aa0a6' },
  };
  const now = () => Date.now();

  // ==========================================================================
  // 1. GM 兼容层 —— 优先扩展存储，拿不到就降级 localStorage，保证永远能跑
  // ==========================================================================
  const GMx = {
    _parse(raw) {
      if (raw === undefined || raw === null) return undefined;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return undefined; }
    },
    async get(key, dflt) {
      let gmRaw, lsRaw;
      try {
        if (typeof GM !== 'undefined' && GM.getValue) gmRaw = await GM.getValue(key);
        else if (typeof GM_getValue === 'function') gmRaw = GM_getValue(key);
      } catch (e) {}
      try { lsRaw = localStorage.getItem('__fwm__' + key); } catch (e) {}

      const a = this._parse(gmRaw), b = this._parse(lsRaw);
      // 两份都有就取「后存的」那份。关页面那一刻 GM 的异步写入很可能丢，
      // 而同步写的 localStorage 镜像一定落了盘 —— 这时候镜像才是新的，得用它。
      // 取到之后下一次 save 会把它写回 GM，自己就修好了
      if (a && b) return ((b.savedAt || 0) > (a.savedAt || 0)) ? b : a;
      if (a !== undefined) return a;
      if (b !== undefined) return b;
      return dflt;
    },
    async set(key, val) {
      const raw = JSON.stringify(val);
      // 先同步写 localStorage 镜像，再去写 GM。
      // GM.setValue 是异步的（要过扩展的消息通道），页面关掉那一刻发出去的写入
      // 基本收不到 —— 「读到一半关掉、进度没更新」就是这么丢的。
      // localStorage 是同步的，函数一进来就落盘，关页面也拦不住它
      try { localStorage.setItem('__fwm__' + key, raw); } catch (e) {}
      try {
        if (typeof GM !== 'undefined' && GM.setValue) return await GM.setValue(key, raw);
        if (typeof GM_setValue === 'function') return GM_setValue(key, raw);
      } catch (e) {}
      try { localStorage.setItem('__fwm__' + key, raw); } catch (e) {}
    },
    // GitHub API 支持 CORS，所以 GM.xmlHttpRequest 不可用时 fetch 也能顶上
    req(url, opt = {}) {
      return new Promise((resolve, reject) => {
        const gx =
          (typeof GM !== 'undefined' && GM.xmlHttpRequest && GM.xmlHttpRequest.bind(GM)) ||
          (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) || null;
        if (gx) {
          gx({
            url, method: opt.method || 'GET', headers: opt.headers || {}, data: opt.body,
            timeout: 25000,
            onload: (r) => resolve({ status: r.status, text: r.responseText }),
            onerror: () => reject(new Error('网络请求失败')),
            ontimeout: () => reject(new Error('请求超时')),
          });
        } else {
          fetch(url, { method: opt.method || 'GET', headers: opt.headers, body: opt.body })
            .then(async (r) => resolve({ status: r.status, text: await r.text() }))
            .catch(() => reject(new Error('网络请求失败（页面 CSP 可能拦截了）')));
        }
      });
    },
  };

  // ==========================================================================
  // 2. 数据层
  //    books[bid]            书：标签、总评、阅读进度
  //    chaps[bid|cid]        章：标签、备注
  //    site                  学到的本站 URL 规律
  //    删除一律软删（deleted:true + updatedAt），否则同步会把删掉的复活
  // ==========================================================================
  const DB = {
    d: null,
    async load() {
      this.d = await GMx.get('db', null) || {};
      this.d.v = 1;
      this.d.books = this.d.books || {};
      this.d.chaps = this.d.chaps || {};
      this.d.bmks = this.d.bmks || {};
      this.d.tagPool = this.d.tagPool || [];
      this.d.site = this.d.site || {};
      this.d.cfg = Object.assign({
        // GitHub 私有仓库。凭据只存本机，snapshot() 是白名单式的，永不上传
        token: '', repo: '', repoPath: 'fw-marks.json', repoBranch: '',
        davUrl: 'https://dav.jianguoyun.com/dav/fw-marks.json',  // 坚果云 WebDAV
        davUser: '', davPass: '',
        autoSync: true,
      }, this.d.cfg || {});
      this.d.lastSync = this.d.lastSync || 0;
      this.d.status = this.d.status || {}; // { repo: {ok,ts,err}, dav: {...} }
    },
    /*
     * 一次性数据修复（v1.0 → v1.2）。
     * v1.0 靠启发式猜 URL 规律，在这个站上猜错了：书籍主页被当成正文页，
     * 于是「书 ID」和「章 ID」被解析成同一个数字。后果是
     *   · progress.cid == 书 ID  → 点「继续读」跳回书籍主页本身 = 原地刷新
     *   · chaps 里存了一堆 cid == bid 的假章节
     * 这类记录一眼可辨（章 ID 不可能等于书 ID），直接清掉，重新读一遍就会记对。
     * 用软删除，这样云端那份也会被一起修掉。
     */
    migrate() {
      if (this.d.mig1) { return 0; }
      let n = 0;
      const bogus = new Set();

      for (const k in this.d.chaps) {
        const c = this.d.chaps[k];
        if (String(c.cid) === String(c.bid) && !c.deleted) {
          c.deleted = true; c.updatedAt = now();
          bogus.add(String(c.bid)); n++;
        }
      }
      for (const b of Object.values(this.d.books)) {
        if (b.progress && String(b.progress.cid) === String(b.id)) {
          b.progress = null; b.updatedAt = now();
          bogus.add(String(b.id)); n++;
        }
      }
      // 这些 id 其实是「某一章」被当成了「一本书」。
      // 但只有整条都没东西时才删 —— 万一是真书，标记和书签必须留着。
      for (const id of bogus) {
        const b = this.d.books[id];
        if (!b || b.deleted) continue;
        const empty = !(b.tags || []).length && !b.review &&
          !this.chapsOf(id).length && !this.bmksOf(id).length;
        if (empty) { b.deleted = true; b.updatedAt = now(); n++; }
      }

      this.d.mig1 = true;
      this.save();
      return n;
    },

    _t: null,
    save() { // 防抖，连点标签不会反复序列化整包
      this.d.savedAt = now();   // GMx.get 靠它判断 GM 和 localStorage 镜像哪份更新
      clearTimeout(this._t);
      this._t = setTimeout(() => GMx.set('db', this.d), 250);
    },
    saveNow() { this.d.savedAt = now(); clearTimeout(this._t); return GMx.set('db', this.d); },

    book(bid, create) {
      if (!bid) return null;
      let b = this.d.books[bid];
      if (!b && create) b = this.d.books[bid] = { id: bid, title: '', url: '', tags: [], review: '', progress: null, updatedAt: now() };
      return b || null;
    },
    chap(bid, cid, create) {
      if (!bid || !cid) return null;
      const k = bid + '|' + cid;
      let c = this.d.chaps[k];
      if (!c && create) c = this.d.chaps[k] = { bid, cid, title: '', url: '', mark: null, note: '', updatedAt: now() };
      return c || null;
    },
    touch(o) { o.updatedAt = now(); this.save(); },
    addTag(t) {
      t = (t || '').trim();
      if (t && !this.d.tagPool.includes(t)) { this.d.tagPool.push(t); this.save(); }
    },
    liveBooks() {
      return Object.values(this.d.books).filter((b) => !b.deleted);
    },
    chapsOf(bid) {
      return Object.values(this.d.chaps).filter((c) => c.bid === bid && !c.deleted);
    },

    // ---- 书签 ----
    // 和「阅读进度」的区别：进度每本书只有一条、会被自动覆盖；
    // 书签是手动的、一本书可以有很多条、只有你自己能删。
    bmksOf(bid) {
      return Object.values(this.d.bmks)
        .filter((m) => m.bid === bid && !m.deleted)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    bmksOfChap(bid, cid) {
      return this.bmksOf(bid).filter((m) => m.cid === cid);
    },
    // 同一章里位置几乎一样的书签（防手抖点重复）
    bmkNear(bid, cid, cpct, tol = 0.05) {
      return this.bmksOfChap(bid, cid).find((m) => Math.abs((m.cpct || 0) - (cpct || 0)) <= tol) || null;
    },
    addBmk(pos) {
      const key = pos.bid + '|' + pos.cid + '-' + now();
      const m = Object.assign({ key, createdAt: now(), updatedAt: now() }, pos);
      this.d.bmks[key] = m;
      this.save();
      return m;
    },
  };
  await DB.load();
  const migrated = DB.migrate();   // 清掉 v1.0 猜错 URL 规律留下的假记录

  // ==========================================================================
  // 3. 云同步（GitHub 私有仓库 + 坚果云）—— 逐条时间戳合并，不是整包覆盖
  // ==========================================================================
  /*
   * UTF-8 安全的 base64 互转。
   * 编码分块处理：一次性 spread 十几万个字节（整包数据上传时就这么大）
   * 会把调用栈撑爆，所以每 32KB 一段。
   * 解码要先去掉空白 —— GitHub Contents API 返回的 base64 是带换行的，
   * 直接喂给 atob 会抛异常。
   */
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let out = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(out);
  };
  const unb64 = (b) => {
    const bin = atob(String(b).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  // ---- 云端后端：两个都实现同一套 {ready, pull, push} 接口 ----
  const Backends = {
    /*
     * GitHub 私有仓库（Contents API）。
     * 为什么不用 gist：gist 的 public:false 只是「不被列出」，拿到链接谁都能看，
     * 不是鉴权存储。私有仓库是真鉴权的。
     * 顺带一个好处：细粒度 PAT 可以只授权这一个仓库的 Contents 读写，
     * 比 classic token 的 `gist` scope（能读写你名下所有 gist）爆炸半径小得多。
     */
    repo: {
      label: 'GitHub 私有仓库',
      ready: () => !!(DB.d.cfg.token && DB.d.cfg.repo),
      _sha: null,          // 上次见到的文件版本号，PUT 更新时必须带上
      hdr: () => ({
        Authorization: 'Bearer ' + DB.d.cfg.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      }),
      api() {
        const repo = (DB.d.cfg.repo || '').trim().replace(/^\/+|\/+$|\.git$/g, '');
        const path = (DB.d.cfg.repoPath || 'fw-marks.json').trim().replace(/^\/+/, '');
        const br = (DB.d.cfg.repoBranch || '').trim();
        return {
          base: 'https://api.github.com/repos/' + repo + '/contents/' +
                path.split('/').map(encodeURIComponent).join('/'),
          ref: br ? '?ref=' + encodeURIComponent(br) : '',
          branch: br,
        };
      },
      err(status) {
        if (status === 401) return 'Token 无效或已过期';
        if (status === 403) return 'Token 没有这个仓库的 Contents 权限';
        if (status === 404) return '仓库或路径不对（owner/仓库名 写对了吗？）';
        return 'HTTP ' + status;
      },
      async pull() {
        const { base, ref } = this.api();
        const r = await GMx.req(base + ref, { headers: this.hdr() });
        if (r.status === 404) { this._sha = null; return null; } // 文件还没建，第一次用
        if (r.status >= 300) throw new Error(this.err(r.status));
        const j = JSON.parse(r.text);
        this._sha = j.sha || null;
        if (!j.content) return null;
        return JSON.parse(unb64(j.content));
      },
      async push(snap) {
        const { base, branch } = this.api();
        const body = () => {
          const o = {
            message: '废文网书签同步（脚本自动提交）',
            content: b64(JSON.stringify(snap)),
          };
          if (this._sha) o.sha = this._sha;
          if (branch) o.branch = branch;
          return JSON.stringify(o);
        };
        let r = await GMx.req(base, { method: 'PUT', headers: this.hdr(), body: body() });
        // 409/422 = 手里的 sha 过期了（别的设备刚推过）。重新取一次再试一遍
        if (r.status === 409 || r.status === 422) {
          await this.pull();
          r = await GMx.req(base, { method: 'PUT', headers: this.hdr(), body: body() });
        }
        if (r.status >= 300) throw new Error(this.err(r.status));
        const j = JSON.parse(r.text || '{}');
        if (j.content && j.content.sha) this._sha = j.content.sha; // 记住新 sha，下次省一次 GET
      },
    },

    dav: {
      label: '坚果云',
      ready: () => !!(DB.d.cfg.davUrl && DB.d.cfg.davUser && DB.d.cfg.davPass),
      hdr: () => ({
        Authorization: 'Basic ' + b64(DB.d.cfg.davUser + ':' + DB.d.cfg.davPass),
        'Content-Type': 'application/json; charset=utf-8',
        // 用 header 防缓存，不用 ?t= 查询串 —— 有些 WebDAV 服务端会把带查询串的路径当成另一个文件
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      }),
      async pull() {
        const r = await GMx.req(DB.d.cfg.davUrl, { headers: this.hdr() });
        if (r.status === 404) return null; // 文件还不存在，第一次用
        if (r.status === 401) throw new Error('账号或应用密码不对');
        if (r.status >= 300) throw new Error('HTTP ' + r.status);
        if (!r.text || !r.text.trim()) return null;
        try { return JSON.parse(r.text); }
        catch (e) { throw new Error('云端文件不是合法 JSON（被别的东西覆盖了？）'); }
      },
      async push(snap) {
        const r = await GMx.req(DB.d.cfg.davUrl, {
          method: 'PUT', headers: this.hdr(), body: JSON.stringify(snap),
        });
        if (r.status === 401) throw new Error('账号或应用密码不对');
        if (r.status === 409) throw new Error('路径的上级文件夹不存在，去坚果云里先建好');
        if (r.status === 507) throw new Error('坚果云空间满了');
        if (r.status >= 300) throw new Error('HTTP ' + r.status);
      },
    },
  };

  const Sync = {
    busy: false,
    // 只把需要跨设备的部分传上去；token / 密码绝不上传
    snapshot() {
      return {
        v: 1, books: DB.d.books, chaps: DB.d.chaps, bmks: DB.d.bmks,
        tagPool: DB.d.tagPool, site: DB.d.site, savedAt: now(),
      };
    },
    // 合并：同一条记录谁的 updatedAt 新就留谁
    mergeMap(local, remote) {
      const out = Object.assign({}, local);
      for (const k in remote) {
        const l = out[k], r = remote[k];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) out[k] = r;
      }
      return out;
    },
    apply(remote) {
      if (!remote || remote.v !== 1) throw new Error('数据格式不认识');
      DB.d.books = this.mergeMap(DB.d.books, remote.books || {});
      DB.d.chaps = this.mergeMap(DB.d.chaps, remote.chaps || {});
      DB.d.bmks = this.mergeMap(DB.d.bmks, remote.bmks || {});
      DB.d.tagPool = [...new Set([...DB.d.tagPool, ...(remote.tagPool || [])])];
      if (remote.site && !Object.keys(DB.d.site).length) DB.d.site = remote.site;
    },

    /*
     * 一轮同步：两边都拉 → 和本地逐条比时间戳合并 → 合并结果推回两边。
     * 所以「取最新的、更新落后的」是自动的：哪边旧，push 时就被补齐。
     * 某一边挂掉不影响另一边 —— 用 allSettled，各报各的成败。
     */
    async run(silent) {
      if (this.busy) return;
      const active = Object.entries(Backends).filter(([, b]) => b.ready());
      if (!active.length) { if (!silent) toast('还没配置任何云端喵'); return; }
      this.busy = true;
      if (!silent) toast('同步中…', 0);

      const errs = [], oks = [];
      try {
        // 1) 并发拉取
        const pulled = await Promise.allSettled(active.map(([, b]) => b.pull()));
        pulled.forEach((res, i) => {
          const [key, b] = active[i];
          if (res.status === 'fulfilled') {
            if (res.value) {
              try { this.apply(res.value); }
              catch (e) { errs.push(`${b.label}拉取：${e.message}`); }
            }
          } else {
            errs.push(`${b.label}拉取：${res.reason.message}`);
            DB.d.status[key] = { ok: false, ts: now(), err: res.reason.message };
          }
        });

        // 2) 合并后的完整快照推回每一边（落后的那边就此被补齐）
        const snap = this.snapshot();
        const pushed = await Promise.allSettled(active.map(([, b]) => b.push(snap)));
        pushed.forEach((res, i) => {
          const [key, b] = active[i];
          if (res.status === 'fulfilled') {
            oks.push(b.label);
            DB.d.status[key] = { ok: true, ts: now(), err: '' };
          } else {
            errs.push(`${b.label}上传：${res.reason.message}`);
            DB.d.status[key] = { ok: false, ts: now(), err: res.reason.message };
          }
        });

        if (oks.length) DB.d.lastSync = now();
        await DB.saveNow();
        refreshUI();
        if (!silent) {
          if (!errs.length) toast(`同步完成 ✓ (${oks.join(' + ')})`);
          else if (oks.length) toast(`部分成功：${oks.join('+')} ✓\n${errs.join('；')}`, 4200);
          else toast('同步失败：' + errs.join('；'), 4200);
        }
      } catch (e) {
        if (!silent) toast('同步失败：' + e.message, 3500);
      } finally {
        this.busy = false;
      }
    },
  };

  // ==========================================================================
  // 4. 页面识别
  //    废文网的真实结构（对着线上 DOM 逐条校验过，不是猜的）：
  //      /threads/{tid}/profile   书籍介绍 + 目录。手机版目录是一排 a.btn-block，
  //                              桌面版是 .hidden-xs.table-hover 里的 table
  //      /threads/{tid}?page=N    正文页：一页塞好几章，每章一个 div#post{pid}
  //                              同一页里还混着回帖 —— 回帖没有标题行，据此剔掉
  //      /posts/{pid}            单章固定链接（下面跟着该章的回帖）
  //      /books /thread_index    书列表：article.item1id{tid}
  //    所以：书 ID = threadId，章 ID = postId。
  //    万一换镜像域名/网站改版，退回下面那套通用启发式 + 长按校准。
  // ==========================================================================
  const nums = (u) => (new URL(u, location.href).pathname.match(/\d+/g) || []);
  const pat = (u) => {
    const x = new URL(u, location.href);
    return x.pathname.replace(/\d+/g, 'N');
  };

  // ---- 站点适配器：选择器全集中在这里，改版只要动这一块 ----
  const FW = {
    SEL: {
      postBlock:   '[id^="post"]',                                    // div#post{pid}
      chapTitle:   '.main-text .text-center strong a[href*="/posts/"]',
      catalogWrap: '.hidden-sm.hidden-md.hidden-lg, .hidden-xs.table-hover',
      catalogLink: 'a[href*="/posts/"]',
      bookCrumb:   (tid) => 'a[href$="/threads/' + tid + '/profile"]', // 面包屑里的书名
    },
    bodyOf: (pid) => '#full' + pid,

    // 纯靠 URL 定页面类型，比猜 DOM 稳
    route() {
      const p = location.pathname;
      let m;
      // 目录有两个入口：书籍介绍页(profile) 和 纯目录列表(chapter_index)，结构一样
      if ((m = p.match(/^\/threads\/(\d+)\/(?:profile|chapter_index)/)))
        return { type: 'catalog', tid: m[1] };
      if ((m = p.match(/^\/threads\/(\d+)(?:[/?]|$)/)))  return { type: 'chapter', tid: m[1] };
      if ((m = p.match(/^\/posts\/(\d+)(?:[/?]|$)/)))    return { type: 'chapter', pid: m[1] };
      if (/^\/(books|thread_index|tag|channels|collection|status_collection|book_selector|user)/.test(p))
        return { type: 'list' };
      return null;
    },

    /*
     * 本页所有「章节」块。这个站有两种排版，都要认：
     *   A) /threads/{tid}   一页多章，章节标题是 .text-center > strong > a[/posts/…]
     *                       同页混着回帖 —— 回帖没有标题行，据此排除
     *   B) /posts/{pid}     单章固定链接页，标题是 <strong class="h5">，里面没有链接
     *                       （h3 是书名）。同页还跟着 4 条回帖，且它们也都有
     *                       .main-text / #full{id}，所以只认 URL 指的那一条
     */
    chapters() {
      const out = [];
      const only = (location.pathname.match(/^\/posts\/(\d+)/) || [])[1] || null;

      for (const el of document.querySelectorAll(this.SEL.postBlock)) {
        const m = /^post(\d+)$/.exec(el.id || '');
        if (!m) continue;
        const pid = m[1];
        if (only && pid !== only) continue;

        let titleEl = el.querySelector(this.SEL.chapTitle);          // 排版 A
        if (!titleEl && only) {                                      // 排版 B
          titleEl = el.querySelector('.text-center strong.h5') ||
                    el.querySelector('.text-center strong');
        }
        if (!titleEl) continue;

        out.push({
          pid,
          el,
          title: (titleEl.textContent || '').replace(/\s+/g, ' ').trim(),
          titleEl,
          body: el.querySelector(this.bodyOf(pid)) || el.querySelector('.main-text'),
        });
      }
      return out;
    },

    // /posts/{pid} 的 URL 里没有书 ID，从页面里捞
    tidFromDom() {
      for (const el of document.querySelectorAll('[id^="itemcollection"]')) {
        const m = /^itemcollection(\d+)$/.exec(el.id);
        if (m) return m[1];
      }
      for (const a of document.querySelectorAll('a[href*="/threads/"]')) {
        const m = /\/threads\/(\d+)/.exec(a.getAttribute('href') || '');
        if (m) return m[1];
      }
      return null;
    },

    pidOfLink(a) {
      const m = /\/posts\/(\d+)/.exec(a.getAttribute('href') || '');
      return m ? m[1] : null;
    },
    catalogUrl(tid) { return location.origin + '/threads/' + tid + '/profile'; },

    // 站点 <title> 一律是「书名 - 有趣有品有点丧」
    bookTitle() {
      const t = (document.title || '').split(' - ')[0].trim();
      return t && t.length < 80 ? t : '';
    },
  };

  const Page = {
    type: 'other',  // 'catalog' | 'chapter' | 'list' | 'other'
    bid: null, cid: null, title: '', bookTitle: '',
    contentEl: null, chapterLinks: [],
    chapters: [],      // 正文页上的所有章节块
    native: false,     // true = 命中废文网适配器，false = 走通用启发式

    // 找出页面上数量最多的一组同构链接 —— 目录页里那就是章节列表
    scanLinkGroups() {
      const g = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        let u; try { u = new URL(a.href, location.href); } catch (e) { continue; }
        if (u.host !== location.host) continue;
        if (u.pathname === location.pathname) continue;
        const p = u.pathname.replace(/\d+/g, 'N');
        if (!/N/.test(p)) continue; // 章节链接一定带数字
        if (!g.has(p)) g.set(p, []);
        g.get(p).push(a);
      }
      return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
    },

    // 找正文容器：文字最多、且没有哪个子元素独占九成文字的那个
    findContent() {
      let best = null, bestLen = 0;
      for (const el of document.body.querySelectorAll('div,article,section,td,main')) {
        const len = (el.textContent || '').replace(/\s+/g, '').length;
        if (len < 400 || len <= bestLen) continue;
        const hogged = [...el.children].some(
          (c) => (c.textContent || '').replace(/\s+/g, '').length > len * 0.9);
        if (hogged) continue;
        best = el; bestLen = len;
      }
      return bestLen >= 400 ? best : null;
    },

    // 从目录页学规律
    learn(catalogUrl, chapterUrl) {
      const A = nums(catalogUrl), B = nums(chapterUrl);
      if (!B.length) return;
      // 目录 URL 里也出现、且在章节 URL 同位置的数字 → 书 ID
      let bidIdx = B.findIndex((n) => A.includes(n));
      // 章节 URL 里独有的最后一个数字 → 章节 ID
      let cidIdx = B.length - 1;
      if (cidIdx === bidIdx) { bidIdx = cidIdx > 0 ? cidIdx - 1 : -1; }
      DB.d.site = { bidIdx, cidIdx, chapPat: pat(chapterUrl), catalogPat: pat(catalogUrl) };
      DB.save();
    },

    idsFrom(url) {
      const n = nums(url), s = DB.d.site;
      if (s && s.cidIdx != null && n.length > s.cidIdx) {
        return { bid: s.bidIdx >= 0 ? n[s.bidIdx] : (n[0] || null), cid: n[s.cidIdx] };
      }
      // 没学过时的兜底猜测
      if (n.length >= 2) return { bid: n[0], cid: n[n.length - 1] };
      return { bid: n[0] || null, cid: null };
    },

    // 只在真的变了的时候才 touch，否则每次开页面都会顶掉 updatedAt、让同步反复搬砖
    noteBook(bid, title, url, create) {
      if (!bid) return null;
      const b = DB.book(bid, !!create);
      if (!b) return null;
      let dirty = false;
      if (title && b.title !== title) { b.title = title; dirty = true; }
      if (url && b.url !== url) { b.url = url; dirty = true; }
      if (dirty) DB.touch(b);
      return b;
    },

    detect() {
      const r = FW.route();
      if (r) { this.native = true; return this.detectNative(r); }
      return this.detectGeneric();
    },

    // ---- 废文网专用识别 ----
    detectNative(r) {
      this.type = r.type;
      this.bookTitle = FW.bookTitle();

      if (r.type === 'catalog') {
        this.bid = r.tid;
        const wraps = document.querySelectorAll(FW.SEL.catalogWrap);
        this.chapterLinks = [...wraps].flatMap((w) => [...w.querySelectorAll(FW.SEL.catalogLink)]);
        // 目录页顺手把本站规律记下来，通用兜底逻辑也就有谱了
        if (this.chapterLinks.length) this.learn(location.href, this.chapterLinks[0].href);
        this.noteBook(this.bid, this.bookTitle, FW.catalogUrl(this.bid), false);
        return;
      }

      if (r.type === 'chapter') {
        this.chapters = FW.chapters();
        this.bid = r.tid || FW.tidFromDom();
        // 焦点章：/posts/{pid} 就是它本人；/threads 列表页先取第一章，滚动时再跟着视口走
        const focus = (r.pid && this.chapters.find((c) => c.pid === r.pid)) || this.chapters[0] || null;
        if (focus) { this.cid = focus.pid; this.title = focus.title; this.contentEl = focus.body; }
        const b = this.bid ? DB.book(this.bid, false) : null;
        if (b) this.noteBook(this.bid, b.title || this.bookTitle, b.url || FW.catalogUrl(this.bid), false);
        return;
      }
      // r.type === 'list'：不需要认书，paintBookList 自己会逐条找 tid
    },

    // ---- 通用启发式（非废文网 / 改版后的兜底）----
    detectGeneric() {
      const groups = this.scanLinkGroups();
      const top = groups[0];
      const content = this.findContent();
      const contentLen = content ? content.textContent.replace(/\s+/g, '').length : 0;
      const known = DB.d.site.chapPat;

      // 当前页自己就长得像章节页？
      const looksChapter = known ? pat(location.href) === known : contentLen > 900;

      if (!looksChapter && top && top[1].length >= 5) {
        // ---- 目录页 ----
        this.type = 'catalog';
        this.chapterLinks = top[1];
        if (!known) this.learn(location.href, top[1][0].href); // 顺手学规律
        this.bid = this.idsFrom(location.href).bid ?? nums(location.href)[0] ?? null;
        this.bookTitle = this.guessBookTitle();
        const b = DB.book(this.bid, true);
        if (b && !b.title) { b.title = this.bookTitle; b.url = location.href; DB.touch(b); }
        else if (b) { b.url = location.href; DB.save(); }
      } else if (content || looksChapter) {
        // ---- 正文页 ----（URL 模式已匹配时，即使正文没认出来也算章节页，标签照打）
        this.type = 'chapter';
        this.contentEl = content;
        const ids = this.idsFrom(location.href);
        this.bid = ids.bid; this.cid = ids.cid;
        this.title = this.guessChapterTitle();
        const b = DB.book(this.bid, false);
        this.bookTitle = (b && b.title) || this.guessBookTitleFromChapter();
      }
    },

    guessBookTitle() {
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim().length < 60) return h1.textContent.trim();
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) return og.content.trim();
      return (document.title || '').split(/[-_|·—>»]/)[0].trim();
    },
    guessBookTitleFromChapter() {
      // 正文页找「返回目录 / 书名」这类链接
      for (const a of document.querySelectorAll('a[href]')) {
        if (DB.d.site.catalogPat && pat(a.href) === DB.d.site.catalogPat) {
          const t = a.textContent.trim();
          if (t && t.length < 40 && !/目录|书页|返回|首页/.test(t)) return t;
        }
      }
      const parts = (document.title || '').split(/[-_|·—>»]/).map((s) => s.trim()).filter(Boolean);
      return parts.length >= 2 ? parts[1] : '';
    },
    guessChapterTitle() {
      const h = document.querySelector('h1,h2,.title,#title');
      if (h && h.textContent.trim().length < 80) return h.textContent.trim();
      return (document.title || '').split(/[-_|·—>»]/)[0].trim();
    },
  };
  Page.detect();

  // 章节固定链接。正文页的 URL 指的是整个 thread（还带 ?page=），
  // 存进数据里的必须是 /posts/{pid}，否则「全部书签」点过去会跳错地方
  const chapUrl = (cid) =>
    (Page.native && cid ? location.origin + '/posts/' + cid : location.href);

  /*
   * 记一个「位置」—— 阅读进度和书签共用同一个结构，所以两边定位行为完全一致。
   *   cid    哪一章
   *   cpct   这一章内部读到百分之几（换字号/换设备都还算得准）
   *   anchor 视口顶部那句话的前 40 字，回来时优先靠它精准复位
   *   pct    整页百分比，最后的兜底
   * atTop=true 表示「从这一章开头」，用于给不在视口里的章节加书签。
   * url 存 /posts/{pid} 而不是当前 ?page=N —— 作者一更新，页码就会漂，
   * 章节固定链接才是稳的。
   */
  function capturePos(cid, atTop) {
    const pid = cid || Page.cid;
    const ch = Page.chapters.find((c) => c.pid === pid);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;

    let cpct = 0, anchor = '';
    if (!atTop && ch) {
      const r = ch.el.getBoundingClientRect();
      if (r.height > 0) cpct = Math.min(1, Math.max(0, (80 - r.top) / r.height));
    }
    const scope = ch ? ch.body : Page.contentEl;
    if (scope) {
      for (const el of scope.children) {
        const r = el.getBoundingClientRect();
        // atTop 时不看视口，直接取这一章第一段有字的
        if (atTop || (r.bottom > 60 && r.top < window.innerHeight * 0.5)) {
          const t = (el.textContent || '').replace(/\s+/g, '').trim();
          if (t.length >= 8) { anchor = t.slice(0, 40); break; }
        }
      }
    }
    return {
      bid: Page.bid, cid: pid,
      title: ch ? ch.title : Page.title,
      url: chapUrl(pid),
      pct, cpct, anchor, ts: now(),
    };
  }

  // ==========================================================================
  // 5. 阅读进度：记 scrollPct + 视口顶部那句话
  //    只靠百分比的话，换字号/换设备就飘了；存一句锚文本能精准找回来
  // ==========================================================================
  const Progress = {
    capture() {
      if (Page.type !== 'chapter' || !Page.bid || !Page.cid) return null;
      return capturePos(Page.cid, false);
    },
    record() {
      const p = this.capture();
      if (!p) return;
      const b = DB.book(Page.bid, true);
      b.progress = p; b.url = b.url || '';
      if (!b.title && Page.bookTitle) b.title = Page.bookTitle;
      DB.touch(b);
    },
    // 回到上次位置：优先用锚文本，找不到再退回百分比
    restore(p) {
      if (!p) return;
      const go = () => {
        // 一页多章：先锁定是哪一章，再在那一章里面找锚文本
        const ch = Page.chapters.find((c) => c.pid === p.cid);
        const scope = (ch && ch.body) || Page.contentEl;
        if (p.anchor && scope) {
          for (const el of scope.children) {
            const t = (el.textContent || '').replace(/\s+/g, '');
            if (t && t.startsWith(p.anchor.slice(0, 20))) {
              el.scrollIntoView({ block: 'start' });
              window.scrollBy(0, -60);
              toast('已回到上次位置 ✓');
              return;
            }
          }
        }
        // 锚文本没对上（作者改字了之类）：退回到那一章 + 章内百分比
        if (ch) {
          const r = ch.el.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + r.top - 80 + r.height * (p.cpct || 0) });
          toast('已回到这一章 ✓');
          return;
        }
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: max * (p.pct || 0) });
        toast('已回到大致位置 ✓');
      };
      setTimeout(go, 300); // 等图片/排版稳定
    },
  };

  // 一页好几章，所以「当前章」要跟着视口走：取视口上沿之上、最靠近的那一章
  function currentChapter() {
    if (!Page.chapters.length) return null;
    let best = null, bestTop = -Infinity;
    for (const c of Page.chapters) {
      const top = c.el.getBoundingClientRect().top;
      if (top <= 120 && top > bestTop) { bestTop = top; best = c; }
    }
    return best || Page.chapters[0];
  }
  function syncFocus() {
    const c = currentChapter();
    if (!c || c.pid === Page.cid) return false;
    Page.cid = c.pid; Page.title = c.title; Page.contentEl = c.body;
    return true;
  }

  /*
   * 跳到某个位置（书签 / 继续读）。
   * 目标章就在本页 → 直接滚过去；不在本页 → 把位置寄存在 sessionStorage，
   * 跳过去之后新页面读出来再复位。用 sessionStorage 是因为它不参与云同步、
   * 关掉标签页就没了，纯粹是一次导航的接力棒。
   */
  const JUMP_KEY = '__fw_jump__';

  /*
   * 该跳到哪个地址。
   * 认得出章 ID 就一律用章节固定链接 /posts/{cid} —— 存量数据里的 url 不可信：
   *   · v1.0 会把书籍主页误判成正文页，于是把「书籍主页自己的地址」存成了进度地址，
   *     点了等于原地刷新
   *   · 存 ?page=N 的话，作者一更新页码就漂了
   * 只有通用兜底模式（认不出章 ID）才退回用存下来的 url。
   */
  function jumpTarget(pos) {
    if (pos.cid && Page.native) return location.origin + '/posts/' + pos.cid;
    const u = pos.url || '';
    const same = u && u.split('#')[0] === location.href.split('#')[0];
    if (!u || same) return pos.cid ? location.origin + '/posts/' + pos.cid : '';
    return u;
  }

  function jumpTo(pos) {
    if (!pos) return;
    // 目标章就在本页 → 直接滚过去，不用刷新
    if (Page.type === 'chapter' && Page.chapters.some((c) => c.pid === pos.cid)) {
      closeSheet();
      Progress.restore(pos);
      return;
    }
    const to = jumpTarget(pos);
    if (!to) { toast('这条记录没存住位置喵，重新读一次就好'); return; }
    // 接力棒：跳过去之后新页面读出来再复位
    try { sessionStorage.setItem(JUMP_KEY, JSON.stringify(pos)); } catch (e) {}
    location.href = to;
  }
  function takePendingJump() {
    try {
      const raw = sessionStorage.getItem(JUMP_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(JUMP_KEY);
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /*
   * 加 / 取消书签。
   * 同一章里位置差不多（±5%）的地方再点一次 = 取消，
   * 这样手抖连点不会攒出一堆几乎一样的书签。
   * atTop：给不在视口里的那一章加书签时，从章首算。
   */
  function toggleBmk(cid, atTop) {
    if (Page.type !== 'chapter' || !Page.bid) { toast('这一页没法加书签喵'); return false; }
    const pos = capturePos(cid, atTop);
    if (!pos.cid) { toast('没认出是哪一章喵'); return false; }

    const dup = DB.bmkNear(Page.bid, pos.cid, pos.cpct);
    if (dup) {
      dup.deleted = true;
      DB.touch(dup);
      toast('书签已取消');
    } else {
      Page.noteBook(Page.bid, Page.bookTitle, FW.catalogUrl(Page.bid), true);
      DB.addBmk(pos);
      toast(`🔖 已加书签：${pos.title || '本章'} ${Math.round((pos.cpct || 0) * 100)}%`);
    }
    paintAll();
    if (sheet.classList.contains('on')) render();
    return true;
  }

  if (Page.type === 'chapter') {
    let t = null;
    addEventListener('scroll', () => {
      // 换章只更新「当前章」指针。面板开着时不重绘，
      // 否则正在打字的备注会被冲掉
      syncFocus();
      clearTimeout(t);
      // 450ms 而不是 1200ms：读一半直接关掉的话，挂太久的防抖就白记了
      t = setTimeout(() => Progress.record(), 450);
    }, { passive: true });
    // 进正文页先记一次，至少知道读到哪章了
    setTimeout(() => { syncFocus(); Progress.record(); }, 800);

    // 刚从书签/继续读跳过来 → 直接复位，不再问「回去吗」
    const jump = takePendingJump();
    const jumpHere = jump && Page.chapters.some((c) => c.pid === jump.cid);
    if (jumpHere) setTimeout(() => Progress.restore(jump), 400);

    // 否则：上次读到的那一章就在本页时，问一句要不要接着读
    const b = DB.book(Page.bid, false);
    const here = b && b.progress && Page.chapters.some((c) => c.pid === b.progress.cid);
    if (!jumpHere && here && (b.progress.cpct > 0.03 || b.progress.pct > 0.03) && window.scrollY < 50) {
      setTimeout(() => {
        const nm = b.progress.title ? `「${b.progress.title}」` : '上次的位置';
        confirmBar(`上次读到 ${nm} ${Math.round((b.progress.cpct || b.progress.pct) * 100)}%，回去吗？`,
          () => Progress.restore(b.progress));
      }, 600);
    }
  }

  // ==========================================================================
  // 6. UI —— 全部塞进 Shadow DOM，不受网站样式影响
  // ==========================================================================
  const host = document.createElement('div');
  host.id = '__fw_marks__';
  const R = host.attachShadow({ mode: 'open' });
  R.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, system-ui, "PingFang SC", sans-serif; -webkit-tap-highlight-color: transparent; }
  button, input, textarea { font: inherit; }

  .mask {
    position: fixed; inset: 0; background: rgba(0,0,0,.42);
    z-index: 2147483100; display: none;
  }
  .mask.on { display: block; }

  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 86vh;
    background: #fff; color: #1c1c1e; z-index: 2147483200;
    border-radius: 16px 16px 0 0; box-shadow: 0 -4px 24px rgba(0,0,0,.25);
    transform: translateY(100%); transition: transform .24s ease;
    display: flex; flex-direction: column;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .sheet.on { transform: translateY(0); }
  .sheet header {
    display: flex; align-items: center; gap: 8px;
    padding: 13px 14px; border-bottom: 1px solid #ececec; flex: none;
  }
  .sheet header h3 { margin: 0; font-size: 15px; flex: 1; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sheet header .sub { font-size: 11px; color: #8e8e93; font-weight: 400; }
  .body { overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px; flex: 1; }

  .row { margin-bottom: 16px; }
  .row > label { display: block; font-size: 12px; color: #8e8e93; margin-bottom: 7px; }

  .marks { display: flex; gap: 8px; }
  .marks button {
    flex: 1; padding: 13px 0; border-radius: 10px; border: 1.5px solid #e2e2e4;
    background: #fff; color: #444; font-size: 15px; font-weight: 500;
  }
  .marks button.on { color: #fff; border-color: transparent; }

  textarea, input[type=text], input[type=password] {
    width: 100%; border: 1.5px solid #e2e2e4; border-radius: 10px;
    padding: 10px 11px; font-size: 14px; background: #fafafa; color: #1c1c1e;
  }
  textarea { min-height: 76px; resize: vertical; line-height: 1.5; }

  .tags { display: flex; flex-wrap: wrap; gap: 7px; }
  .tags .t {
    padding: 6px 11px; border-radius: 14px; font-size: 13px;
    background: #f0f0f2; color: #555; border: 1.5px solid transparent;
  }
  .tags .t.on { background: #ffe9e8; color: #e8554e; border-color: #e8554e; }
  .tags .t.add { background: #fff; border: 1.5px dashed #c8c8cc; color: #8e8e93; }

  .btns { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
  .btn {
    flex: 1; min-width: 92px; padding: 12px; border: none; border-radius: 10px;
    background: #e8554e; color: #fff; font-size: 14px; font-weight: 500;
  }
  .btn.g { background: #f0f0f2; color: #333; }
  .btn.sm { flex: none; min-width: 0; padding: 8px 13px; font-size: 13px; }

  .book { border: 1px solid #ececec; border-radius: 11px; padding: 11px 12px; margin-bottom: 9px; }
  .book .bt { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
  .book .meta { font-size: 11.5px; color: #8e8e93; line-height: 1.7; }
  .book .rv { font-size: 12.5px; color: #555; margin-top: 5px; line-height: 1.5;
    background: #fafafa; padding: 6px 8px; border-radius: 7px; }
  .chaplist { margin-top: 8px; border-top: 1px dashed #e5e5e7; padding-top: 7px; display: none; }
  .chaplist.on { display: block; }
  .chaplist a {
    display: block; font-size: 12.5px; color: #2b6cb0; text-decoration: none;
    padding: 5px 0; border-bottom: 1px solid #f5f5f7; line-height: 1.5;
  }
  .chaplist .n { color: #8e8e93; font-size: 11.5px; display: block; }

  .bmklist { margin-top: 8px; border-top: 1px dashed #e5e5e7; padding-top: 7px; display: none; }
  .bmklist.on { display: block; }
  .bmk { display: flex; align-items: flex-start; gap: 6px;
    padding: 5px 0; border-bottom: 1px solid #f5f5f7; }
  .bmk .go { flex: 1; min-width: 0; font-size: 12.5px; color: #2b6cb0;
    line-height: 1.5; cursor: pointer; }
  .bmk .go .n { color: #8e8e93; font-size: 11.5px; display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bmk .bx { flex: none; display: flex; gap: 4px; }
  .bmk .bx .btn { padding: 3px 8px; font-size: 11px; margin: 0; }

  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px;
    font-size: 10.5px; color: #fff; margin-right: 4px; vertical-align: middle; }

  .toast {
    position: fixed; left: 50%; bottom: 30%; transform: translateX(-50%);
    background: rgba(0,0,0,.84); color: #fff; padding: 11px 18px;
    border-radius: 20px; font-size: 13.5px; z-index: 2147483600;
    max-width: 82vw; text-align: center; display: none;
    white-space: pre-line; line-height: 1.55;
    /* 必须穿透点击：提示条横跨页面中部，没这行的话它显示那几秒里，
       它盖住的那一条带全都点不动（刚保存完紧接着那一下点击会被吃掉） */
    pointer-events: none;
  }
  .toast.on { display: block; }

  /* 和 toast 同理：这条确认栏横跨底部整宽、要挂好几秒，整条接点击的话
     它盖住的网站按钮在这期间全点不动。所以条子本体穿透，只有按钮接点击。 */
  .cbar { pointer-events: none; }
  .cbar button { pointer-events: auto; }
  .cbar {
    position: fixed; left: 12px; right: 12px; bottom: 20px;
    background: rgba(28,28,30,.94); color: #fff; border-radius: 13px;
    padding: 11px 13px; display: none; align-items: center; gap: 10px;
    z-index: 2147483500; font-size: 13.5px;
    margin-bottom: env(safe-area-inset-bottom, 0);
  }
  .cbar.on { display: flex; }
  .cbar span { flex: 1; }
  .cbar button { border: none; border-radius: 8px; padding: 7px 13px; font-size: 13px; }
  .cbar .y { background: #e8554e; color: #fff; }
  .cbar .n { background: #48484a; color: #ddd; }

  .hint { font-size: 11.5px; color: #8e8e93; line-height: 1.65; margin-top: 7px; }
  .hint code { background: #f0f0f2; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  .empty { text-align: center; color: #aeaeb2; font-size: 13px; padding: 34px 0; }
</style>

<div class="mask"></div>
<div class="sheet">
  <header><h3></h3><span class="sub"></span><button class="btn g sm cls">关闭</button></header>
  <div class="body"></div>
</div>
<div class="toast"></div>
<div class="cbar"><span></span><button class="n">不用</button><button class="y">好</button></div>
`;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => R.querySelector(s);
  const mask = $('.mask'), sheet = $('.sheet');
  const sTitle = $('.sheet header h3'), sSub = $('.sheet header .sub'), sBody = $('.body');

  let toastTimer;
  function toast(msg, ms = 1800) {
    const el = $('.toast');
    el.textContent = msg; el.classList.add('on');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
  function confirmBar(msg, onYes) {
    const bar = $('.cbar');
    bar.querySelector('span').textContent = msg;
    bar.classList.add('on');
    const hide = () => bar.classList.remove('on');
    bar.querySelector('.y').onclick = () => { hide(); onYes(); };
    bar.querySelector('.n').onclick = hide;
    setTimeout(hide, 9000);
  }
  const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let view = 'ctx';
  // 在正文页也想看「这本书」的面板时置位。用独立开关而不是去改 Page.type，
  // 免得改完之后这一页就再也渲染不出章节面板了
  let forceBook = false;
  function openSheet(v) { view = v || 'ctx'; render(); mask.classList.add('on'); sheet.classList.add('on'); }
  function closeSheet() {
    mask.classList.remove('on'); sheet.classList.remove('on');
    forceBook = false;
  }
  // 页面上各处入口统一走这里
  function openView(v) {
    forceBook = (v === 'book');
    openSheet(v === 'book' ? 'ctx' : v);
  }
  mask.onclick = closeSheet;
  $('.cls').onclick = closeSheet;
  function refreshUI() { if (sheet.classList.contains('on')) render(); paintAll(); }


  // ==========================================================================
  // 7. 面板渲染
  // ==========================================================================
  function render() {
    if (view === 'all') return renderAll();
    if (view === 'cfg') return renderCfg();
    if (forceBook) return renderBook();
    if (Page.type === 'chapter') return renderChapter();
    if (Page.type === 'catalog') return renderBook();
    return renderAll();
  }

  function navBtns(extra = '') {
    return `<div class="btns" style="margin-top:18px">
      ${extra}
      <button class="btn g" data-go="all">📚 全部书签</button>
      <button class="btn g" data-go="cfg">⚙️ 同步设置</button>
    </div>`;
  }

  // 网址里没认出书/章编号时的兜底提示
  function renderUnknown(what) {
    sTitle.textContent = '没认出这一页';
    sSub.textContent = '';
    sBody.innerHTML = `<div class="empty">没能从网址里认出${what}编号喵。<br><br>
      去这本书的<b>目录页</b>，从「⚙️ 同步设置」里点<b>重新校准</b>，<br>再点一下任意章节链接就能教会本喵。</div>${navBtns()}`;
  }

  // ---- 书签列表（章节面板 / 书籍面板 / 全部书签 三处共用）----
  // 书签就是个纯位置，不起名字：章节名 + 百分比 + 那句原文，足够认出是哪儿了
  function bmkListHTML(list, emptyHint, showChap) {
    if (!list.length) return emptyHint ? `<div class="hint">${esc(emptyHint)}</div>` : '';
    return list.map((m) => `
      <div class="bmk">
        <div class="go" data-bmkgo="${esc(m.key)}">
          <span class="pill" style="background:#d98b00">${Math.round((m.cpct || 0) * 100)}%</span>
          ${showChap ? esc(m.title || m.cid) : ''}
          ${m.anchor ? `<span class="n">${esc(m.anchor.slice(0, 26))}…</span>` : ''}
        </div>
        <span class="bx">
          <button class="btn g sm" data-bmkdel="${esc(m.key)}">删</button>
        </span>
      </div>`).join('');
  }

  // ---- 正文页：给这一章打标签 + 备注 ----
  function renderChapter() {
    if (!Page.bid || !Page.cid) return renderUnknown('章节');
    const c = DB.chap(Page.bid, Page.cid, false);
    const cur = c ? c.mark : null;
    sTitle.textContent = Page.title || '本章';
    sSub.textContent = Page.bookTitle || '';
    const bms = DB.bmksOfChap(Page.bid, Page.cid);
    sBody.innerHTML = `
      <div class="row">
        <label>书签</label>
        <button class="btn" data-act="addBmk">🔖 在我现在读到的位置加书签</button>
        ${bmkListHTML(bms, '本章还没有书签喵', false)}
      </div>
      <div class="row">
        <label>本章评价</label>
        <div class="marks">
          ${Object.entries(MARKS).map(([k, m]) =>
            `<button data-mark="${k}" class="${cur === k ? 'on' : ''}"
              style="${cur === k ? 'background:' + m.color : ''}">${m.label}</button>`).join('')}
        </div>
      </div>
      <div class="row">
        <label>备注（可不填）</label>
        <textarea data-note placeholder="随手写一句…">${esc(c ? c.note : '')}</textarea>
      </div>
      <div class="btns">
        <button class="btn" data-act="saveChap">保存</button>
        ${cur || (c && c.note) ? '<button class="btn g" data-act="clearChap">清除本章</button>' : ''}
      </div>
      ${navBtns('<button class="btn g" data-go="book">📖 这本书</button>')}
    `;
  }

  // ---- 目录页：整本书的总评 + 标签 + 继续阅读 ----
  function renderBook() {
    if (!Page.bid) return renderUnknown('书籍');
    const b = DB.book(Page.bid, true);
    const marked = DB.chapsOf(Page.bid).filter((c) => c.mark || c.note);
    const bmks = DB.bmksOf(Page.bid);
    const pool = DB.d.tagPool;
    sTitle.textContent = b.title || Page.bookTitle || '这本书';
    sSub.textContent = [marked.length ? `已标 ${marked.length} 章` : '',
                        bmks.length ? `🔖 ${bmks.length}` : ''].filter(Boolean).join(' · ');
    sBody.innerHTML = `
      ${b.progress ? `<div class="row">
        <label>阅读进度（自动记的，会被覆盖）</label>
        <button class="btn" data-act="continue">▶ 继续读：${esc(b.progress.title || '上次的位置')} · ${Math.round((b.progress.cpct || b.progress.pct || 0) * 100)}%</button>
      </div>` : ''}
      <div class="row">
        <label>书签（手动加的，不会被覆盖）${bmks.length ? ' · ' + bmks.length + ' 个' : ''}</label>
        ${bmkListHTML(bmks, '这本书还没有书签喵。读正文时点章节下面那个 🔖 就能加。', true)}
      </div>
      <div class="row">
        <label>书籍标签（点一下选中／取消）</label>
        <div class="tags">
          ${pool.map((t) => `<span class="t ${b.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}
          <span class="t add" data-act="newtag">＋ 新标签</span>
        </div>
      </div>
      <div class="row">
        <label>总评</label>
        <textarea data-review placeholder="这本书读下来感觉如何…">${esc(b.review)}</textarea>
      </div>
      <div class="btns"><button class="btn" data-act="saveBook">保存</button></div>
      ${navBtns()}
      <div class="hint">目录里每章标题后面会直接显示你打的标签喵。<br>
        角标位置不对的话，去「⚙️ 同步设置」点<b>重新校准</b>，再指认一次章节链接。</div>
    `;
  }

  // ---- 管理面板：所有书 + 搜索 ----
  // 搜索时只重绘列表、不动输入框 —— 否则 iOS 上每输一个字键盘都会闪一下
  let searchKw = '';
  function renderAll(kw) {
    if (kw !== undefined) searchKw = kw;
    sTitle.textContent = '全部书签';
    sBody.innerHTML = `
      <div class="row"><input type="text" data-search placeholder="搜书名 / 标签 / 章节 / 备注…"
        value="${esc(searchKw)}" autocapitalize="off" autocorrect="off"></div>
      <div data-list></div>
      ${navBtns()}
    `;
    paintList();
  }

  function paintList() {
    const kw = searchKw;
    const books = DB.liveBooks().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const hit = (b) => {
      if (!kw) return true;
      const k = kw.toLowerCase();
      return (b.title || '').toLowerCase().includes(k) ||
        (b.review || '').toLowerCase().includes(k) ||
        b.tags.some((t) => t.toLowerCase().includes(k)) ||
        DB.chapsOf(b.id).some((c) => (c.title || '').toLowerCase().includes(k) || (c.note || '').toLowerCase().includes(k)) ||
        DB.bmksOf(b.id).some((m) => (m.title || '').toLowerCase().includes(k) ||
          (m.anchor || '').toLowerCase().includes(k));
    };
    const list = books.filter(hit);
    sSub.textContent = kw ? `${list.length} / ${books.length} 本` : `${books.length} 本`;
    const box = sBody.querySelector('[data-list]');
    if (!box) return;
    box.innerHTML = `
      ${list.length ? list.map((b) => {
        const cs = DB.chapsOf(b.id).filter((c) => c.mark || c.note);
        const bs = DB.bmksOf(b.id);
        const cnt = { good: 0, ok: 0, skip: 0 };
        cs.forEach((c) => { if (c.mark) cnt[c.mark]++; });
        return `<div class="book" data-bid="${esc(b.id)}">
          <div class="bt">${esc(b.title || '（未命名 · ' + b.id + '）')}</div>
          <div class="meta">
            ${Object.entries(cnt).filter(([, v]) => v).map(([k, v]) =>
              `<span class="pill" style="background:${MARKS[k].color}">${MARKS[k].label} ${v}</span>`).join('')}
            ${b.tags.length ? '<br>🏷 ' + b.tags.map(esc).join(' · ') : ''}
            ${b.progress ? `<br>▶ 读到「${esc(b.progress.title || '')}」${Math.round((b.progress.cpct || b.progress.pct || 0) * 100)}%` : ''}
            ${bs.length ? `<br>🔖 ${bs.length} 个书签` : ''}
          </div>
          ${b.review ? `<div class="rv">${esc(b.review)}</div>` : ''}
          <div class="btns" style="margin-top:8px">
            ${b.progress ? `<button class="btn sm" data-jump="${esc(b.progress.url)}">继续读</button>` : ''}
            ${b.url ? `<button class="btn g sm" data-jump="${esc(b.url)}">去目录</button>` : ''}
            ${cs.length ? `<button class="btn g sm" data-toggle>标记章节 ${cs.length}</button>` : ''}
            ${bs.length ? `<button class="btn g sm" data-bmktoggle>🔖 书签 ${bs.length}</button>` : ''}
            <button class="btn g sm" data-del="${esc(b.id)}">删除</button>
          </div>
          <div class="bmklist">${bmkListHTML(bs, '', true)}</div>
          <div class="chaplist">
            ${cs.sort((a, c) => (c.updatedAt || 0) - (a.updatedAt || 0)).map((c) => `
              <a href="${esc(c.url)}">
                ${c.mark ? `<span class="pill" style="background:${MARKS[c.mark].color}">${MARKS[c.mark].label}</span>` : ''}
                ${esc(c.title || c.cid)}
                ${c.note ? `<span class="n">📝 ${esc(c.note)}</span>` : ''}
              </a>`).join('')}
          </div>
        </div>`;
      }).join('') : `<div class="empty">${kw ? '没搜到喵' : '还没有任何标记喵～<br>去书里点几下吧'}</div>`}
    `;
  }

  // ---- 设置 / 同步 ----
  function renderCfg() {
    const c = DB.d.cfg;
    // 每个云端的健康状态：✅ / ⚠️ + 失败原因
    const st = (key) => {
      const s = DB.d.status[key];
      if (!Backends[key].ready()) return '<span style="color:#aeaeb2">未配置</span>';
      if (!s) return '<span style="color:#aeaeb2">待同步</span>';
      const t = new Date(s.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return s.ok
        ? `<span style="color:#34a853">✅ ${t}</span>`
        : `<span style="color:#e8554e">⚠️ ${t}　${esc(s.err)}</span>`;
    };
    sTitle.textContent = '同步设置';
    sSub.textContent = DB.d.lastSync ? '上次 ' + new Date(DB.d.lastSync).toLocaleString('zh-CN') : '尚未同步';
    sBody.innerHTML = `
      <div class="hint" style="margin:0 0 16px;background:#f7f7f9;padding:10px;border-radius:9px">
        两个云端是<b>互为备份</b>喵：同步时两边都拉下来，和本地<b>逐条比时间戳取最新</b>，
        再把合并结果推回两边——落后的那边会被自动补齐，一边挂了另一边照常用。
      </div>

      <div class="row">
        <label>① GitHub 私有仓库　${st('repo')}</label>
        <input type="password" data-token placeholder="Token：github_pat_…（细粒度）" value="${esc(c.token)}">
        <input type="text" data-repo placeholder="仓库：owner/仓库名" value="${esc(c.repo)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="text" data-repopath placeholder="文件路径（默认 fw-marks.json）" value="${esc(c.repoPath)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="text" data-repobranch placeholder="分支（留空＝仓库默认分支）" value="${esc(c.repoBranch)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <div class="hint">
          GitHub → Settings → Developer settings → <b>Fine-grained tokens</b> →
          Repository access 选 <b>Only select repositories</b> 挑你那个<b>私有</b>仓库 →
          Permissions 里只给 <b>Contents: Read and write</b> 就够喵。<br>
          文件不存在会自动创建。<b>别用公共仓库</b> —— 这里存的是你读了什么、标了什么。
          ${c.repo ? `<br>👉 <a href="https://github.com/${esc(c.repo)}" target="_blank">打开这个仓库</a>` : ''}
        </div>
      </div>

      <div class="row">
        <label>② 坚果云 WebDAV　${st('dav')}</label>
        <input type="text" data-davurl placeholder="WebDAV 文件地址" value="${esc(c.davUrl)}">
        <input type="text" data-davuser placeholder="账号（坚果云注册邮箱）" value="${esc(c.davUser)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="password" data-davpass placeholder="应用密码（不是登录密码！）" value="${esc(c.davPass)}" style="margin-top:7px">
        <div class="hint">
          坚果云 → 账户信息 → <b>安全选项</b> → 添加应用 → 生成的那串就是应用密码喵。<br>
          地址默认写到你坚果云根目录的 <code>fw-marks.json</code>；想放进某个文件夹就改成
          <code>…/dav/文件夹名/fw-marks.json</code>，<b>文件夹要先在坚果云里建好</b>。
        </div>
      </div>

      <div class="row">
        <label><input type="checkbox" data-auto ${c.autoSync ? 'checked' : ''}> 打开网页时自动后台同步（静默，失败不打扰）</label>
      </div>
      <div class="btns">
        <button class="btn" data-act="saveCfg">保存设置</button>
        <button class="btn g" data-act="syncNow">立即同步</button>
      </div>
      <div class="hint">Token 和密码<b>只存在这台设备</b>，永远不会被传到任何云端喵。</div>
      <div class="row" style="margin-top:22px">
        <label>本地备份</label>
        <div class="btns">
          <button class="btn g" data-act="export">复制导出 JSON</button>
          <button class="btn g" data-act="import">粘贴导入</button>
        </div>
      </div>
      <div class="row">
        <label>站点识别规则</label>
        <div class="hint">
          ${DB.d.site.chapPat
            ? `已学会：章节链接形如 <code>${esc(DB.d.site.chapPat)}</code>`
            : '还没学会（去一次目录页就会自动学）'}
        </div>
        <div class="btns" style="margin-top:8px">
          <button class="btn g sm" data-act="recal">重新校准</button>
        </div>
      </div>
      ${navBtns()}
    `;
  }

  // ==========================================================================
  // 8. 面板交互（事件委托）
  // ==========================================================================
  sBody.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-mark],[data-act],[data-go],[data-tag],[data-jump],[data-del],' +
      '[data-toggle],[data-bmkgo],[data-bmkdel],[data-bmktoggle]');
    if (!t) return;

    // ---- 书签 ----
    if (t.dataset.bmkgo) {
      const m = DB.d.bmks[t.dataset.bmkgo];
      if (m && !m.deleted) jumpTo(m);
      return;
    }
    if (t.dataset.bmkdel) {
      const m = DB.d.bmks[t.dataset.bmkdel];
      if (m) { m.deleted = true; DB.touch(m); }
      toast('书签已删'); render(); paintAll();
      return;
    }
    // 注意：data-bmktoggle 的值是空字符串（falsy），必须用 hasAttribute
    if (t.hasAttribute('data-bmktoggle')) {
      t.closest('.book').querySelector('.bmklist').classList.toggle('on');
      return;
    }

    // 章节标签（点已选中的可取消）
    if (t.dataset.mark) {
      const c = DB.chap(Page.bid, Page.cid, true);
      c.mark = c.mark === t.dataset.mark ? null : t.dataset.mark;
      c.deleted = false;
      c.title = Page.title; c.url = chapUrl(Page.cid);
      DB.touch(c);
      const b = DB.book(Page.bid, true);
      if (!b.title && Page.bookTitle) { b.title = Page.bookTitle; DB.touch(b); }
      render(); paintAll();
      return;
    }
    if (t.dataset.go) {
      if (t.dataset.go === 'book') { forceBook = true; view = 'ctx'; }
      else { forceBook = false; view = t.dataset.go; }
      render();
      sBody.scrollTop = 0;
      return;
    }
    if (t.dataset.jump) { location.href = t.dataset.jump; return; }
    // 注意：dataset.toggle 是空字符串（falsy），必须用 hasAttribute 判断
    if (t.hasAttribute('data-toggle')) { t.closest('.book').querySelector('.chaplist').classList.toggle('on'); return; }
    if (t.dataset.del) {
      const b = DB.d.books[t.dataset.del];
      if (!b) return;
      confirmBar(`删除「${b.title || b.id}」的全部标记和书签？`, () => {
        b.deleted = true; b.updatedAt = now();
        DB.chapsOf(b.id).forEach((c) => { c.deleted = true; c.updatedAt = now(); });
        DB.bmksOf(b.id).forEach((m) => { m.deleted = true; m.updatedAt = now(); });
        DB.save(); render(); paintAll(); toast('已删除喵');
      });
      return;
    }
    if (t.dataset.tag) {
      const b = DB.book(Page.bid, true);
      const tag = t.dataset.tag;
      b.tags = b.tags.includes(tag) ? b.tags.filter((x) => x !== tag) : [...b.tags, tag];
      if (!b.title && Page.bookTitle) b.title = Page.bookTitle;
      DB.touch(b); render(); paintAll();
      return;
    }

    switch (t.dataset.act) {
      case 'saveChap': {
        const c = DB.chap(Page.bid, Page.cid, true);
        c.note = sBody.querySelector('[data-note]').value.trim();
        c.deleted = false;
        c.title = Page.title; c.url = chapUrl(Page.cid);
        DB.touch(c); await DB.saveNow();
        toast('保存好了喵 ✓'); closeSheet(); paintAll();
        break;
      }
      case 'clearChap': {
        const c = DB.chap(Page.bid, Page.cid, false);
        if (c) { c.deleted = true; c.mark = null; c.note = ''; DB.touch(c); }
        toast('已清除'); render(); paintAll();
        break;
      }
      case 'saveBook': {
        const b = DB.book(Page.bid, true);
        b.review = sBody.querySelector('[data-review]').value.trim();
        if (!b.title) b.title = Page.bookTitle;
        b.url = b.url || (Page.native ? FW.catalogUrl(Page.bid) : location.href);
        DB.touch(b); await DB.saveNow();
        toast('保存好了喵 ✓'); closeSheet(); paintAll();
        break;
      }
      case 'newtag': {
        const v = prompt('新标签（比如：甜文 / 追更中 / 弃坑）');
        if (v && v.trim()) {
          DB.addTag(v.trim());
          const b = DB.book(Page.bid, true);
          if (!b.tags.includes(v.trim())) b.tags.push(v.trim());
          if (!b.title && Page.bookTitle) b.title = Page.bookTitle;
          DB.touch(b); render(); paintAll();
        }
        break;
      }
      case 'addBmk':
        toggleBmk(Page.cid, false);
        break;
      case 'continue': {
        const b = DB.book(Page.bid, false);
        if (b && b.progress) jumpTo(b.progress);
        break;
      }
      case 'saveCfg': {
        const v = (s) => sBody.querySelector(s).value.trim();
        DB.d.cfg.token = v('[data-token]');
        DB.d.cfg.repo = v('[data-repo]');
        DB.d.cfg.repoPath = v('[data-repopath]') || 'fw-marks.json';
        DB.d.cfg.repoBranch = v('[data-repobranch]');
        Backends.repo._sha = null;   // 换了仓库/路径，旧的文件版本号就作废了
        DB.d.cfg.davUrl = v('[data-davurl]');
        DB.d.cfg.davUser = v('[data-davuser]');
        DB.d.cfg.davPass = v('[data-davpass]');
        DB.d.cfg.autoSync = sBody.querySelector('[data-auto]').checked;
        await DB.saveNow();
        const on = Object.values(Backends).filter((b) => b.ready()).length;
        toast(on === 2 ? '双备份已就绪喵 ✓' : on === 1 ? '已保存（只配了一个云端喵）' : '已保存');
        render();
        break;
      }
      case 'syncNow': await Sync.run(false); break;
      case 'export': {
        const json = JSON.stringify(Sync.snapshot(), null, 1);
        try {
          await navigator.clipboard.writeText(json);
          toast('已复制到剪贴板 ✓');
        } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = json; ta.style.cssText = 'position:fixed;opacity:0;top:0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
          toast('已复制到剪贴板 ✓');
        }
        break;
      }
      case 'import': {
        const v = prompt('把导出的 JSON 粘进来（会与现有数据合并，不覆盖）');
        if (!v) break;
        try {
          Sync.apply(JSON.parse(v));
          await DB.saveNow();
          toast('导入完成 ✓'); render(); paintAll();
        } catch (err) { toast('JSON 解析失败：' + err.message, 3000); }
        break;
      }
      case 'recal': closeSheet(); startCalibrate(); break;
    }
  });

  let searchTimer;
  sBody.addEventListener('input', (e) => {
    if (!e.target.matches('[data-search]')) return;
    searchKw = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(paintList, 120); // 只重绘列表，输入框原地不动
  });

  // 小球上挂个黄点：这一章已经标过了

  // ==========================================================================
  // 9. 直接画在网页上的标记 —— 不点开插件也能一眼看到
  //    · 目录页：每章标题后挂标签色块、📝、▶（读到这里）
  //    · 书籍介绍页：书名后挂书籍标签，目录上方压一条「上次读到哪」
  //    · 书列表/搜索结果：书名后挂书籍标签 + 读到哪章 + 标了几章
  //    · 正文页：每章标题下面一条行内标记条，直接点就能打标签
  //    全部走内联样式，不受网站 CSS 影响；节点带 data-fw-* 便于原地更新
  // ==========================================================================

  // 往 host 里塞/更新/移除一个角标。html 为空串就把角标撤掉
  function attachBadge(host, html, where) {
    if (!host) return;
    let el = [...host.children].find((x) => x.dataset && x.dataset.fwBadge === '1');
    if (!html) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      el.dataset.fwBadge = '1';
      el.style.cssText =
        'display:inline-block;margin-left:5px;font-size:11px;font-weight:400;' +
        'vertical-align:middle;white-space:nowrap';
      if (where === 'before') host.insertBefore(el, host.firstChild);
      else host.appendChild(el);
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  const pill = (bg, txt) =>
    `<span style="background:${bg};color:#fff;padding:1px 6px;border-radius:8px;margin-left:3px">${txt}</span>`;

  // 章节角标：标签色块 + 备注图标 + 书签数 + 「读到这里」
  function chapBadgeHTML(c, isCur, nb) {
    const live = c && !c.deleted;
    const m = live && c.mark ? MARKS[c.mark] : null;
    return (isCur ? '<span style="color:#e8554e;font-weight:700">▶</span> ' : '') +
      (m ? pill(m.color, m.label) : '') +
      (live && c.note ? `<span title="${esc(c.note)}" style="margin-left:3px">📝</span>` : '') +
      (nb ? `<span style="margin-left:3px;color:#d98b00" title="${nb} 个书签">🔖${nb > 1 ? nb : ''}</span>` : '');
  }

  // 书籍角标：自定义标签 + 读到哪章 + 标了几章 + 有总评
  function bookBadgeHTML(b) {
    if (!b || b.deleted) return '';
    const tags = (b.tags || []).map((t) => pill('#5a6b8c', esc(t))).join('');
    const prog = b.progress
      ? pill('#e8554e', '▶ ' + esc((b.progress.title || '').slice(0, 14) || '读过'))
      : '';
    const n = DB.chapsOf(b.id).filter((c) => c.mark || c.note).length;
    const cnt = n ? `<span style="color:#999;margin-left:4px">${n}章</span>` : '';
    const nb = DB.bmksOf(b.id).length;
    const bm = nb ? `<span style="color:#d98b00;margin-left:4px" title="${nb} 个书签">🔖${nb}</span>` : '';
    const rev = b.review ? '<span style="margin-left:3px" title="有总评">📝</span>' : '';
    return tags + prog + cnt + bm + rev;
  }

  // ---- 目录页：每章后面挂角标 ----
  function paintCatalog() {
    if (Page.type !== 'catalog' || !Page.bid) return;
    const links = Page.native
      ? [...document.querySelectorAll(FW.SEL.catalogWrap)]
          .flatMap((w) => [...w.querySelectorAll(FW.SEL.catalogLink)])
      : (DB.d.site.chapPat
          ? [...document.querySelectorAll('a[href]')].filter((a) => {
              try { return pat(a.href) === DB.d.site.chapPat; } catch (e) { return false; }
            })
          : Page.chapterLinks);

    const prog = (DB.book(Page.bid, false) || {}).progress;
    for (const a of links) {
      // 桌面版目录一行里有两个链接指向同一章，只在最后那个上挂角标，免得画两遍
      const row = a.closest('tr');
      if (row) {
        const all = row.querySelectorAll(FW.SEL.catalogLink);
        if (all.length && all[all.length - 1] !== a) continue;
      }
      const cid = Page.native ? FW.pidOfLink(a) : Page.idsFrom(a.href).cid;
      if (!cid) continue;
      attachBadge(a, chapBadgeHTML(
        DB.chap(Page.bid, cid, false),
        !!(prog && prog.cid === cid),
        DB.bmksOfChap(Page.bid, cid).length));
    }
  }

  // ---- 书籍介绍页：书名后挂标签 + 目录上方一条「上次读到哪」 ----
  function paintProfile() {
    if (Page.type !== 'catalog' || !Page.bid) return;
    const b = DB.book(Page.bid, false);

    // 书名在面包屑里：首页 / 频道 / 《书名》
    const crumbs = document.querySelectorAll(FW.SEL.bookCrumb(Page.bid));
    if (crumbs.length) attachBadge(crumbs[crumbs.length - 1], bookBadgeHTML(b));

    // 进度条压在目录容器所在面板的最上面（只插一条，不然手机/桌面两份都会显示）
    const wrap = document.querySelector(FW.SEL.catalogWrap);
    const panel = wrap && wrap.closest('.panel-body');
    if (!panel) return;
    const p = b && b.progress;
    let strip = panel.querySelector(':scope > [data-fw-strip]');
    if (!p) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.setAttribute('data-fw-strip', '1');
      strip.style.cssText =
        'margin:0 0 10px;padding:8px 10px;border-radius:8px;cursor:pointer;' +
        'background:#e8554e14;border:1px solid #e8554e55;color:#e8554e;' +
        'font-size:13px;line-height:1.5;text-align:center';
      // 点的时候重新读一遍进度，别用建条子那一刻捕获的旧值
      strip.addEventListener('click', () => {
        const bb = DB.book(Page.bid, false);
        if (bb && bb.progress) jumpTo(bb.progress);
      });
      panel.insertBefore(strip, panel.firstChild);
    }
    const html = `▶ 上次读到 <b>${esc(p.title || '某一章')}</b> · ${Math.round((p.cpct || p.pct || 0) * 100)}% —— 点这里继续`;
    if (strip.innerHTML !== html) strip.innerHTML = html;
  }

  /*
   * 书列表 / 收藏 / 首页 / 频道 / 搜索结果：书名后面挂书籍标签。
   *
   * 不靠条目的 class —— 这站每个页面的写法都不一样（books 用 item1id{n}、
   * 收藏用 thread{n}、频道和 thread_index 用 threadid{n}…），认了一处就漏三处。
   * 改成直接认「书名链接」：凡是指向 /threads/{n} 或 /threads/{n}/profile 的
   * 链接就挂角标，一招通吃所有页面。
   * 带 ?query 的跳过 —— 那是排序/筛选链接，不是书名。
   */
  function paintBookList() {
    for (const a of document.querySelectorAll('a[href*="/threads/"]')) {
      const href = (a.getAttribute('href') || '').trim();   // 注意：站点有的 href 尾部带空格
      if (href.indexOf('?') >= 0) continue;
      const m = /\/threads\/(\d+)(?:\/profile)?$/.exec(href);
      if (!m) continue;
      const b = DB.book(m[1], false);
      if (!b || b.deleted) continue;
      attachBadge(a, bookBadgeHTML(b));
    }
  }

  // ---- 正文页：每章标题下面一条行内标记条 ----
  function paintInline() {
    if (Page.type !== 'chapter' || !Page.bid || !Page.chapters.length) return;
    const prog = (DB.book(Page.bid, false) || {}).progress;
    for (const ch of Page.chapters) {
      const anchor = ch.titleEl.closest('.text-center') || ch.titleEl.parentElement;
      if (!anchor) continue;
      let bar = ch.el.querySelector(':scope [data-fw-bar="' + ch.pid + '"]');
      if (!bar) {
        bar = document.createElement('div');
        bar.setAttribute('data-fw-bar', ch.pid);
        bar.style.cssText =
          'margin:6px 0 12px;text-align:center;font-size:12px;line-height:2;' +
          '-webkit-user-select:none;user-select:none';
        anchor.insertAdjacentElement('afterend', bar);
      }
      const c = DB.chap(Page.bid, ch.pid, false);
      const live = c && !c.deleted;
      const cur = live ? c.mark : null;
      const note = live ? c.note : '';
      const btn = (extra, attrs, txt) =>
        `<span ${attrs} style="display:inline-block;margin:0 3px;padding:2px 11px;border-radius:11px;cursor:pointer;${extra}">${txt}</span>`;
      const nb = DB.bmksOfChap(Page.bid, ch.pid).length;
      const html =
        Object.entries(MARKS).map(([k, m]) =>
          btn(cur === k ? `background:${m.color};color:#fff;font-weight:700` : 'background:#8881;color:#999',
              `data-fw-mark="${k}" data-fw-pid="${ch.pid}"`, m.label)).join('') +
        // 两个钮都写全名字：以前只放 emoji，挨在一起太容易点错
        // —— 备注会弹面板要打字，书签是一点就存，不能让人分不清
        btn(note ? 'background:#8881;color:#e8554e' : 'background:#8881;color:#999',
            `data-fw-note="${ch.pid}"`, note ? '📝 备注·有' : '📝 备注') +
        btn(nb ? 'background:#8881;color:#d98b00;font-weight:700' : 'background:#8881;color:#999',
            `data-fw-bmk="${ch.pid}"`, nb ? '🔖 书签 ' + nb : '🔖 书签') +
        (prog && prog.cid === ch.pid ? '<span style="margin-left:6px;color:#e8554e;font-weight:700">▶ 读到这里</span>' : '');
      if (bar.innerHTML !== html) bar.innerHTML = html;
    }
  }

  /*
   * ---- 面板入口 ----
   * 不用悬浮球：它会实打实压住页面内容（网站自己的按钮正好在那个位置就点不到了），
   * 而且每一页都糊一个球在眼前。改成两个不挡路的入口：
   *   1. 挂进网站顶栏，跟「文库」「收藏」并列，全站都能进
   *   2. 书籍页目录上方一排按钮，就近操作
   * 章节的标记/备注/书签本来就是行内的，根本不需要进面板。
   */
  function injectNavEntry() {
    if (document.querySelector('[data-fw-nav]')) return;
    const ul = document.querySelector('header nav ul.navbar-nav') ||
               document.querySelector('header nav ul') ||
               document.querySelector('nav ul.nav');
    if (!ul) return;

    const li = document.createElement('li');
    li.setAttribute('data-fw-nav', '1');
    const a = document.createElement('a');
    a.setAttribute('data-fw-open', 'all');   // 不给 href，免得被当成真跳转
    a.style.cursor = 'pointer';
    a.textContent = '📑 我的标记';
    li.appendChild(a);

    // 插在头像下拉菜单前面，跟其他主项排一起
    const drop = [...ul.children].find((x) => x.classList && x.classList.contains('dropdown'));
    if (drop) ul.insertBefore(li, drop); else ul.appendChild(li);
  }

  function injectPageActions() {
    if (Page.type !== 'catalog' || !Page.bid) return;
    const wrap = document.querySelector(FW.SEL.catalogWrap);
    const panel = wrap && wrap.closest('.panel-body');
    if (!panel) return;

    let bar = panel.querySelector(':scope > [data-fw-actions]');
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-fw-actions', '1');
      bar.style.cssText = 'margin:0 0 12px;text-align:center;font-size:12px;line-height:2.2';
      const strip = panel.querySelector(':scope > [data-fw-strip]');
      if (strip) strip.insertAdjacentElement('afterend', bar);
      else panel.insertBefore(bar, panel.firstChild);
    }

    const b = DB.book(Page.bid, false);
    const nb = DB.bmksOf(Page.bid).length;
    const nc = DB.chapsOf(Page.bid).filter((c) => c.mark || c.note).length;
    const btn = (v, txt) =>
      `<span data-fw-open="${v}" style="display:inline-block;margin:0 4px;padding:3px 12px;` +
      `border-radius:12px;cursor:pointer;background:#8881;color:#666">${txt}</span>`;
    const html =
      btn('book', `📖 标签 / 总评 / 书签${nb ? ' 🔖' + nb : ''}`) +
      btn('all', `📚 全部标记${nc ? ' · 本书 ' + nc + ' 章' : ''}`) +
      btn('cfg', '⚙️');
    if (bar.innerHTML !== html) bar.innerHTML = html;
  }

  function paintAll() {
    injectNavEntry(); injectPageActions();
    paintCatalog(); paintProfile(); paintBookList(); paintInline();
  }
  paintAll();

  // 行内标记条的点击：打标签 / 开备注
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element
      ? e.target.closest('[data-fw-mark],[data-fw-note],[data-fw-bmk],[data-fw-open]') : null;
    if (!t) return;
    e.preventDefault(); e.stopPropagation();

    // 顶栏那一项 / 书籍页那排按钮
    if (t.hasAttribute('data-fw-open')) {
      openView(t.getAttribute('data-fw-open') || 'all');
      return;
    }

    const pid = t.getAttribute('data-fw-pid') || t.getAttribute('data-fw-note')
      || t.getAttribute('data-fw-bmk');
    if (!Page.bid || !pid) return;
    const ch = Page.chapters.find((x) => x.pid === pid);

    // 🔖：正在读的那一章就按当前位置存，别的章就按章首存
    if (t.hasAttribute('data-fw-bmk')) {
      toggleBmk(pid, pid !== Page.cid);
      return;
    }

    // 备注要输入框，交给面板；顺手把焦点章切成它
    if (t.hasAttribute('data-fw-note')) {
      Page.cid = pid;
      if (ch) { Page.title = ch.title; Page.contentEl = ch.body; }
      openSheet('ctx');
      return;
    }

    const k = t.getAttribute('data-fw-mark');
    const c = DB.chap(Page.bid, pid, true);
    c.mark = c.mark === k ? null : k;
    c.deleted = false;
    if (ch) c.title = ch.title;
    c.url = location.origin + '/posts/' + pid;
    DB.touch(c);
    Page.noteBook(Page.bid, Page.bookTitle, FW.catalogUrl(Page.bid), true);
    paintInline();
    toast(c.mark ? `${ch ? ch.title + '：' : ''}${MARKS[c.mark].label} ✓` : '已取消标记');
  }, true);

  // 分页 / 懒加载 / 网站自己改 DOM 时补画
  {
    let mt = null;
    new MutationObserver(() => {
      clearTimeout(mt);
      mt = setTimeout(() => {
        // 正文页 DOM 变了（比如点了「展开」），章节块要重新收一遍
        if (Page.type === 'chapter' && Page.native) Page.chapters = FW.chapters();
        paintAll();
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================================================
  // 10. 校准模式 —— 自动认错了就手动指一个章节链接给它看
  // ==========================================================================
  function startCalibrate() {
    toast('校准模式：请点一下页面里任意一个【章节链接】喵', 5000);
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;inset:0;z-index:2147482000;box-shadow:inset 0 0 0 3px #e8554e;pointer-events:none';
    document.body.appendChild(tip);

    const onClick = (ev) => {
      const a = ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      ev.preventDefault(); ev.stopPropagation();
      cleanup();
      Page.learn(location.href, a.href);
      // 当前这页既然有章节链接，那它就是目录页
      Page.type = 'catalog';
      Page.bid = Page.idsFrom(location.href).bid || nums(location.href)[0];
      DB.book(Page.bid, true);
      DB.save();
      paintCatalog();
      toast(`学会了：${DB.d.site.chapPat} ✓`, 2600);
    };
    const cleanup = () => {
      document.removeEventListener('click', onClick, true);
      tip.remove();
      clearTimeout(bail);
    };
    const bail = setTimeout(() => { cleanup(); toast('校准取消'); }, 15000);
    document.addEventListener('click', onClick, true);
  }

  // ==========================================================================
  // 11. 开机自动同步（安静模式，失败不打扰）
  // ==========================================================================
  if (migrated) {
    setTimeout(() => toast(`修好了 ${migrated} 条旧版存错的记录喵，重新读一次就会记对`, 3600), 1400);
  }

  const anyCloud = Object.values(Backends).some((b) => b.ready());
  if (DB.d.cfg.autoSync && anyCloud && now() - DB.d.lastSync > 5 * 60 * 1000) {
    setTimeout(() => Sync.run(true), 2500);
  }
  // 离开页面前保底存一次
  /*
   * 离开页面前保底记一次。
   * pagehide 之后 GM 的异步写入基本是丢的 —— 真正救命的是 GMx.set 里那一步
   * 同步 localStorage 镜像（它在 await 之前，调用即落盘）。
   * visibilitychange 比 pagehide 早、也更可靠（切标签、切后台、锁屏都会触发），
   * 所以两个都挂上。
   */
  function flush() {
    if (Page.type === 'chapter') Progress.record();
    DB.saveNow();
  }
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
})();
