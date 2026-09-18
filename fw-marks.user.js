// ==UserScript==
// @name         废文网 · 书签标记 & 云同步
// @namespace    didi.fw
// @version      1.12.0
// @description  章节标签(精彩/一般/跳过)、书签(多个/手动/免命名)、整本书书评与自定义标签、阅读进度、目录/书列表/正文页内联角标、GitHub 私有仓库 + 坚果云 WebDAV 双备份同步
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
 * 凭据只存本机，snapshot() 是白名单式的，永远不会被传上云。
 */

(async function () {
  'use strict';
  if (window.top !== window.self) return;

  /*
   * 防重复注入（本地放一份、又按链接加一份远程的，很容易发生）。
   * 标记打在 documentElement 上而不是 window 变量：注入上下文可能是隔离世界，
   * window 彼此看不见但 DOM 是共享的；而且这一步是同步的，不会有竞态。
   */
  if (document.documentElement.dataset.fwMarksLoaded) return;
  document.documentElement.dataset.fwMarksLoaded = '1';

  // <title> 里这些后缀不是书名的一部分
  const FW_PAGE_SUFFIX = /[-－—]\s*(目录列表|章节目录|目录|评荐列表|回帖列表)\s*$/;

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
  //    books[bid]      书：标签、书评        chaps[bid|cid]  章：标签
  //    prog[bid]       阅读进度              bmks[bid|cid-ts] 书签
  //    site            学到的本站 URL 规律
  //
  //    可同步的表都长同一个样子：扁平 map + 字符串 key，每条记录带 updatedAt，
  //    删除一律软删（deleted:true）—— 否则同步会把删掉的复活。
  //    所以合并逻辑只需要一份。加新表只改 COLLECTIONS 这一行。
  // ==========================================================================
  const COLLECTIONS = ['books', 'chaps', 'bmks', 'prog'];

  const DB = {
    d: null,
    async load() {
      this.d = await GMx.get('db', null) || {};
      this.d.v = 1;
      COLLECTIONS.forEach((k) => { this.d[k] = this.d[k] || {}; });
      this.d.tagPool = this.d.tagPool || [];
      this.d.site = this.d.site || {};
      this.d.cfg = Object.assign({
        // GitHub 私有仓库。凭据只存本机，snapshot() 是白名单式的，永不上传
        repoOn: true, davOn: true,   // 各自的总开关，关掉就完全不用它
        // 填的是「文件夹」，里面放哪些文件由脚本自己定（一个表一个文件）
        token: '', repo: '', repoDir: 'fw-marks', repoBranch: '',
        repoPath: '',                // 旧版的单文件路径，只用来读一次老数据
        // 必须带上文件夹那一层：坚果云不让直接写在 /dav/ 根目录
        davDir: 'https://dav.jianguoyun.com/dav/我的坚果云/fw-marks/',
        davUrl: '',                  // 旧版的单文件地址，只用来读一次老数据
        davUser: '', davPass: '',
        autoSync: true,
      }, this.d.cfg || {});
      this.d.lastSync = this.d.lastSync || 0;
      this.d.status = this.d.status || {}; // { repo: {ok,ts,err}, dav: {...} }
    },
    /*
     * 迁移链：一条一条叠加，各自有独立的完成标记。以后改数据结构就加 _mig6，
     * 在下面的表里补一行。顺序有意义 —— mig1 先清掉假记录，
     * mig2 才不会把假进度搬进新表。
     */
    migrate() {
      const steps = [['mig1', '_mig1'], ['mig2', '_mig2'], ['mig3', '_mig3'],
                     ['mig4', '_mig4'], ['mig5', '_mig5'], ['mig6', '_mig6']];
      let n = 0, ran = false;
      for (const [flag, fn] of steps) {
        if (this.d[flag]) continue;
        n += this[fn]();
        this.d[flag] = true;
        ran = true;
      }
      if (ran) this.save();
      return n;
    },

    // v1.5：进度从 books[bid].progress 搬到独立的 prog 表
    _mig2() { return this.migrateLegacyProgress(); },

    // v1.5.1：把历史上已经同步出来的重复书签收掉
    _mig3() { return this.dedupeBmks(); },

    /*
     * v1.11：书签改章级，去重规则从「同章且位置相差 ≤5%」放宽成「同章即重复」，
     * 老数据要按新规则再收一次。老记录身上的 cpct/anchor 留着不删
     * （删是不可逆的，反正也不再读它们 —— 见 data-bmkgo 的处理）。
     */
    _mig5() { return this.dedupeBmks(); },

    /*
     * v1.12：修两处被存脏了的名字。
     *   书名混进了页面后缀（<title> 在目录页是「书名-目录列表 - 站点名」）
     *   章节名混进了我们自己画上去的角标（▶ / 🔖 / 标记色块）
     * no（第几章）不在这里清 —— 残留旧值那个 bug 已经在 capturePos 治住了，
     * 再清一遍只会让还没逛过目录的书白丢掉已经对的序号。
     */
    _mig6() {
      let n = 0;
      const junk = /(\s*(?:▶|🔖\d*|📝|精彩|一般|跳过))+\s*$/;
      const strip = (t) => {
        let out = (t || '').trim(), prev = null;
        while (out !== prev) { prev = out; out = out.replace(junk, '').trim(); }
        return out;
      };
      for (const b of Object.values(this.d.books)) {
        const t = (b.title || '').replace(FW_PAGE_SUFFIX, '').trim();
        if (t && t !== b.title) { b.title = t; b.updatedAt = now(); n++; }
      }
      for (const map of [this.d.chaps, this.d.bmks]) {
        for (const r of Object.values(map)) {
          const t = strip(r.title);
          if (t !== (r.title || '')) { r.title = t; r.updatedAt = now(); n++; }
        }
      }
      for (const p of Object.values(this.d.prog)) {
        const t = strip(p.title);
        if (t !== (p.title || '')) { p.title = t; p.updatedAt = now(); n++; }
      }
      return n;
    },

    // v1.8：同步改成「一文件夹、一表一文件」。从老的文件路径推出文件夹，
    // 用户不用重填；老路径保留，首次同步会读它一次把老数据并进来
    _mig4() {
      const c = this.d.cfg;
      let n = 0;
      if (c.davUrl && !/\/$/.test(c.davDir || '')) {
        c.davDir = c.davUrl.replace(/[^/]+$/, '');   // 去掉文件名，只留文件夹
        n++;
      }
      if (c.repoPath && c.repoPath.includes('/')) {
        c.repoDir = c.repoPath.replace(/\/[^/]+$/, '');
        n++;
      }
      return n;
    },

    // 不只首次迁移要用：另一台设备还没升级时，它推上云的进度仍塞在书记录里，
    // 所以每次合并完都要再搬一次
    migrateLegacyProgress() {
      let n = 0;
      for (const b of Object.values(this.d.books)) {
        if (!b.progress) continue;
        const old = this.d.prog[b.id];
        // 两边都有就以时间新的为准
        if (!old || (b.updatedAt || 0) > (old.updatedAt || 0)) {
          this.d.prog[b.id] = Object.assign({ bid: b.id }, b.progress,
            { updatedAt: b.updatedAt || now(), deleted: false });
        }
        delete b.progress;
        n++;
      }
      return n;
    },

    _mig1() {
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

      return n;
    },

    /*
     * ---- 跨页面 / 跨标签页的写入冲突 ----
     * 每个页面都有自己那份内存里的 DB.d，整包写回去就是谁最后写谁赢 ——
     * Safari 的「返回」是页面缓存，恢复出来的老页面一存就把刚记的进度冲掉了。
     * 所以写之前先读出存储里那份、逐条比 updatedAt 合并，再写。
     * 读用同步的 localStorage 镜像：GM 的读是异步的，页面正在关掉那一刻等不起。
     */
    _raw: null,          // 上一次我们自己写进去的原文，用来判「别人动过没」
    storedRaw() {
      try { return localStorage.getItem('__fwm__db'); } catch (e) { return null; }
    },
    /*
     * 存储里那份。**原文和我们上次写的一模一样就返回 null** —— 中间没人写过，
     * 不用白解析。整包 JSON 有几百 KB，而读正文时每滚一下就要存一次，
     * 每次都全量 parse + 合并会让翻页发卡。
     */
    stored(force) {
      const raw = this.storedRaw();
      if (!raw) return null;
      if (!force && raw === this._raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },

    // 逐条比 updatedAt 取新的，规则和云同步那套一样。
    // 返回 true = 内存里的数据真变了，需要重绘
    mergeStored(o) {
      if (!o || typeof o !== 'object') return false;
      let changed = false;
      for (const k of COLLECTIONS) {
        const src = o[k] || {}, dst = this.d[k] || (this.d[k] = {});
        for (const id in src) {
          const r = src[id], l = dst[id];
          if (!r || typeof r !== 'object') continue;
          if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { dst[id] = r; changed = true; }
        }
      }
      const pool = [...new Set([...(this.d.tagPool || []), ...(o.tagPool || [])])];
      if (pool.length !== (this.d.tagPool || []).length) { this.d.tagPool = pool; changed = true; }

      /*
       * 这几项不是「一条条的记录」，没有 updatedAt，只能整块取新的、用 savedAt 判。
       * _flush 里是先把自己的 savedAt 盖成现在再合并，所以保存时永远内存这份赢
       * （不会冲掉用户刚改的设置）；只有 pullStore 那种主动去拉才会采纳存储那份。
       */
      if ((o.savedAt || 0) > (this.d.savedAt || 0)) {
        this.d.cfg = Object.assign({}, this.d.cfg, o.cfg || {});
        if (o.status) this.d.status = o.status;
        this.d.lastSync = Math.max(this.d.lastSync || 0, o.lastSync || 0);
        this.d.lastCheck = Math.max(this.d.lastCheck || 0, o.lastCheck || 0);
        if (o.site && Object.keys(o.site).length) this.d.site = o.site;
      }
      return changed;
    },

    _t: null,
    _flush() {
      this.d.savedAt = now();        // GMx.get 靠它判断 GM 和 localStorage 镜像哪份更新
      this.mergeStored(this.stored()); // 别整包盖掉别的页面刚写的
      const r = GMx.set('db', this.d);
      this._raw = this.storedRaw();  // 记下这一次写出去的原文
      return r;
    },
    save() { // 防抖，连点标签不会反复序列化整包
      clearTimeout(this._t);
      this._t = setTimeout(() => this._flush(), 250);
    },
    saveNow() { clearTimeout(this._t); return this._flush(); },

    book(bid, create) {
      if (!bid) return null;
      let b = this.d.books[bid];
      if (!b && create) b = this.d.books[bid] = { id: bid, title: '', url: '', tags: [], review: '', updatedAt: now() };
      return b || null;
    },

    /*
     * ---- 阅读进度是单独一张表 ----
     * 塞在书记录里的话，一边读一边刷 book.updatedAt；而合并是「整条取最新」，
     * 于是另一台设备刚加的标签/书评会被进度那次更新整条盖掉。拆开就互不干扰。
     */
    prog(bid) {
      if (!bid) return null;
      const p = this.d.prog[bid];
      // 只看进度自己那条记录。以前还会因为「书记录被删」就不显示，
      // 但进度 / 书签 / 书评 是互相独立的三件事 —— 清掉书评不该让进度消失
      return p && !p.deleted ? p : null;
    },

    /*
     * 读完了没有。两条路，满足一条就算：
     *   1. 你自己按了「✓ 我读完了」—— 实际进度多少都不影响，它照样存着
     *   2. 站点标了「完结」且进度落在最后一章（不要求那一章滚到 100%）
     * 连载中的书读到最新章只是「追上了」，所以第 2 条要求 done === true。
     */
    isFinished(bid) {
      const b = this.d.books[bid];
      if (!b) return false;
      if (b.doneRead === true) return true;
      const p = this.prog(bid);
      if (!p || b.done !== true || !b.chapTotal || !p.no) return false;
      return p.no >= b.chapTotal;
    },

    // 手动标「已读完 / 还没读完」。进度一个字都不动
    setDoneRead(bid, on) {
      const b = this.book(bid, true);
      if (!b) return null;
      b.doneRead = !!on;
      this.touch(b);
      return b;
    },

    // 这一章排第几。靠逛目录学下来的章节顺序（b.cids）查，**不解析标题里的序号**
    // —— 有的书是中文数字、有的只写名字。查不到返回 null，宁可不显示也别显示错的
    chapNo(bid, cid) {
      const b = this.d.books[bid];
      const i = (b && b.cids || []).indexOf(cid);
      return i >= 0 ? i + 1 : null;
    },

    // 「去书籍主页」的地址。不用存下来的 b.url —— 存量数据里那个可能是
    // /posts/{章}（v1.0 认错过），点了会跳到某一章去。直接拿书 id 拼最稳
    bookUrl(bid) { return bid ? location.origin + '/threads/' + bid + '/profile' : ''; },

    // 这本书最后一次「有动静」，给列表排序用。光看 book.updatedAt 不够 ——
    // 一直在读的书，书记录本身可能好久没变过。加新表就往这里补一行
    lastActive(bid) {
      const b = this.d.books[bid];
      const p = this.d.prog[bid];
      return Math.max(
        (b && b.updatedAt) || 0,
        (p && !p.deleted && p.updatedAt) || 0,
      );
    },
    setProg(bid, pos) {
      if (!bid || !pos) return null;
      const p = Object.assign({}, this.d.prog[bid], pos, { bid, deleted: false });
      this.d.prog[bid] = p;
      this.touch(p);
      return p;
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

    // 标签改名 / 删除。要改**所有书**身上那一份 —— 只改标签池的话，
    // 书上还挂着错别字。to 传空串就是删掉这个标签
    renameTag(from, to) {
      from = (from || '').trim(); to = (to || '').trim();
      if (!from || from === to) return 0;
      let n = 0;
      for (const b of this.liveBooks()) {
        if (!(b.tags || []).includes(from)) continue;
        // 改成一个已经存在的标签时要去重，不然同一本书会挂两个一样的
        b.tags = [...new Set(b.tags.map((x) => (x === from ? to : x)))].filter(Boolean);
        this.touch(b); n++;
      }
      this.d.tagPool = [...new Set(this.d.tagPool
        .map((x) => (x === from ? to : x)))].filter(Boolean);
      this.save();
      return n;
    },
    liveBooks() {
      return Object.values(this.d.books).filter((b) => !b.deleted);
    },
    chapsOf(bid) {
      return Object.values(this.d.chaps).filter((c) => c.bid === bid && !c.deleted);
    },

    // ---- 书签 ----
    // 和阅读进度的区别：进度是自动的、每本一条、记到章内位置、会被覆盖；
    // 书签是手动的、**章级**的（一章一条，只记是哪章）、一本书可以标很多章、
    // 只有你自己能删。
    bmksOf(bid) {
      return Object.values(this.d.bmks)
        .filter((m) => m.bid === bid && !m.deleted)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    bmksOfChap(bid, cid) {
      return this.bmksOf(bid).filter((m) => m.cid === cid);
    },
    // 一章最多一条，所以这里就是「这一章标了没」
    bmkOfChap(bid, cid) { return this.bmksOfChap(bid, cid)[0] || null; },
    /*
     * 跨设备去重：书签的 key 带时间戳，所以同一章在两台设备上各标一次，
     * key 不一样、合并时两条都会留下来（新建时的判重管不到合并）。
     *
     * 留哪一条必须**完全由数据决定** —— 两台设备得各自选出同一个幸存者，
     * 否则 A 删掉 B 留的、B 删掉 A 留的，来回拉锯永不收敛。
     * 所以按 (createdAt, key) 排序取第一条。
     */
    dedupeBmks() {
      const groups = new Map();
      for (const k in this.d.bmks) {
        const m = this.d.bmks[k];
        if (!m || m.deleted || !m.bid || !m.cid) continue;
        const g = m.bid + '|' + m.cid;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ k, m });
      }

      let n = 0;
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) =>
          ((a.m.createdAt || 0) - (b.m.createdAt || 0)) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

        const keep = list[0].m;
        for (const { m } of list.slice(1)) {
          // 被丢掉那条身上有幸存者缺的信息，顺手补过去，别白丢
          if (!keep.title && m.title) keep.title = m.title;
          m.deleted = true; m.updatedAt = now();
          n++;
        }
      }
      if (n) this.save();
      return n;
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
   * UTF-8 安全的 base64 互转。两处都是踩过的坑：
   *   编码分 32KB 一段 —— 一次性 spread 十几万个字节会把调用栈撑爆
   *   解码先去空白 —— GitHub Contents API 回的 base64 带换行，atob 会抛
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

  /*
   * 云端后端。两边实现同一套接口：
   *   ready / ensureDir / get(name) / put(name, text) / getLegacy
   *
   * 一个表一个文件（而不是整包一个 JSON）：只改了进度就只推 prog.json，
   * 别的一个字节不动 —— 坚果云免费版每月才 1GB 上传。所以配置里填的是
   * **文件夹**，具体文件名由脚本自己定。
   */
  const SYNC_FILES = () => [...COLLECTIONS.map((k) => k + '.json'), 'meta.json'];
  const LEGACY_FILE = 'fw-marks.json';   // v1.7 及以前的整包单文件

  const Backends = {
    repo: {
      label: 'GitHub 私有仓库',
      ready: () => !!(DB.d.cfg.repoOn && DB.d.cfg.token && DB.d.cfg.repo),
      _sha: {},          // 文件名 → 版本号，PUT 更新时必须带上
      hdr: () => ({
        Authorization: 'Bearer ' + DB.d.cfg.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      }),
      dir() { return (DB.d.cfg.repoDir || '').trim().replace(/^\/+|\/+$/g, ''); },
      api(path) {
        const repo = (DB.d.cfg.repo || '').trim().replace(/^\/+|\/+$|\.git$/g, '');
        const br = (DB.d.cfg.repoBranch || '').trim();
        return {
          url: 'https://api.github.com/repos/' + repo + '/contents/' +
               path.split('/').filter(Boolean).map(encodeURIComponent).join('/'),
          ref: br ? '?ref=' + encodeURIComponent(br) : '',
          branch: br,
        };
      },
      err(status, body) {
        let why = '';
        try { why = (JSON.parse(body || '{}').message || ''); } catch (e) {}
        const base = status === 401 ? 'Token 无效或已过期'
          : status === 403 ? 'Token 没有这个仓库的 Contents 权限'
          : status === 404 ? '仓库或路径不对（owner/仓库名 写对了吗？）'
          : 'HTTP ' + status;
        return why ? base + '（' + why + '）' : base;
      },
      async ensureDir() { /* GitHub 的目录是隐式的，写文件时自动就有了 */ },
      async fetchPath(path) {
        const { url, ref } = this.api(path);
        const r = await GMx.req(url + ref, { headers: this.hdr() });
        if (r.status === 404) return { missing: true };
        if (r.status >= 300) throw new Error(this.err(r.status, r.text));
        const j = JSON.parse(r.text);
        return { text: j.content ? unb64(j.content) : '', sha: j.sha || null };
      },
      async get(name) {
        const path = (this.dir() ? this.dir() + '/' : '') + name;
        const r = await this.fetchPath(path);
        if (r.missing) { delete this._sha[name]; return { missing: true }; }
        this._sha[name] = r.sha;
        return { text: r.text };
      },
      async put(name, text) {
        const path = (this.dir() ? this.dir() + '/' : '') + name;
        const { url, branch } = this.api(path);
        const body = () => {
          const o = { message: '废文网标记同步：' + name, content: b64(text) };
          if (this._sha[name]) o.sha = this._sha[name];
          if (branch) o.branch = branch;
          return JSON.stringify(o);
        };
        let r = await GMx.req(url, { method: 'PUT', headers: this.hdr(), body: body() });
        // 409/422 = 手里的 sha 过期了（别的设备刚推过），重取再试一次
        if (r.status === 409 || r.status === 422) {
          try { await this.get(name); } catch (e) {}
          r = await GMx.req(url, { method: 'PUT', headers: this.hdr(), body: body() });
        }
        if (r.status >= 300) throw new Error(this.err(r.status, r.text));
        const j = JSON.parse(r.text || '{}');
        if (j.content && j.content.sha) this._sha[name] = j.content.sha;
      },
      // v1.7 及以前那份整包文件，迁移时读一次
      async getLegacy() {
        const path = (DB.d.cfg.repoPath || LEGACY_FILE).trim().replace(/^\/+/, '');
        return this.fetchPath(path);
      },
    },

    dav: {
      label: '坚果云',
      ready: () => !!(DB.d.cfg.davOn && DB.d.cfg.davDir &&
                      DB.d.cfg.davUser && DB.d.cfg.davPass),
      hdr: () => ({
        Authorization: 'Basic ' + b64(DB.d.cfg.davUser + ':' + DB.d.cfg.davPass),
        'Content-Type': 'application/json; charset=utf-8',
        // 用 header 防缓存，不用 ?t= 查询串 —— 有些 WebDAV 会把带查询串的路径当成另一个文件
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      }),
      dir() { return (DB.d.cfg.davDir || '').trim().replace(/\/*$/, '/'); },
      /*
       * 坚果云的 /dav/ 根目录只是同步文件夹的列表，不让在上面直接建东西。
       * 所以文件夹至少要有两段：/dav/<同步文件夹>/…
       */
      rootPath() {
        try {
          const p = new URL(this.dir()).pathname.replace(/^\/+|\/+$/g, '');
          return p.split('/').filter(Boolean).length < 2;
        } catch (e) { return false; }
      },
      err(status, body) {
        // 坚果云出错时会在正文里自报原因，比状态码有用得多
        const ex = (/<s:exception>(.*?)<\/s:exception>/.exec(body || '') || [])[1];
        const known = {
          AccountExpired: '坚果云账户已过期或当月流量用尽（免费版每月 1GB 上传，次月重置）',
          NoPermission: '这个文件夹没有写权限（是别人共享给你的只读文件夹？）',
          OverQuota: '坚果云空间或流量用完了',
          InvalidAuth: '账号或应用密码不对（要用「应用密码」，不是登录密码）',
        }[ex];
        if (known) return known;
        if (ex) return ex;
        if (status === 401) return '账号或应用密码不对（要用「应用密码」，不是登录密码）';
        if (status === 403) return '没有写权限';
        if (status === 404) return '路径不存在';
        if (status === 409) return '上级文件夹不存在，先去坚果云里建好';
        if (status === 507) return '坚果云空间满了';
        return 'HTTP ' + status;
      },
      // 文件夹不存在就建一个。MKCOL 幂等：已存在会回 405，当成功处理
      async ensureDir() {
        if (this.rootPath()) {
          throw new Error('地址要指到 …/dav/某个同步文件夹/ 下面，不能是 /dav/ 根目录');
        }
        const r = await GMx.req(this.dir(), { method: 'MKCOL', headers: this.hdr() });
        if (r.status < 300 || r.status === 405) return;
        throw new Error(this.err(r.status, r.text));
      },
      async get(name) {
        const r = await GMx.req(this.dir() + name, { headers: this.hdr() });
        if (r.status === 404) return { missing: true };
        if (r.status >= 300) throw new Error(this.err(r.status, r.text));
        return { text: r.text || '' };
      },
      async put(name, text) {
        const r = await GMx.req(this.dir() + name, {
          method: 'PUT', headers: this.hdr(), body: text,
        });
        if (r.status >= 300) throw new Error(this.err(r.status, r.text));
      },
      async getLegacy() {
        if (!DB.d.cfg.davUrl) return { missing: true };
        const r = await GMx.req(DB.d.cfg.davUrl, { headers: this.hdr() });
        if (r.status === 404) return { missing: true };
        if (r.status >= 300) return { missing: true };
        return { text: r.text || '' };
      },
    },
  };

  const Sync = {
    busy: false,

    /*
     * 键排序后再序列化。
     * 两台设备合并出来的 key 顺序可能不同，不排的话内容明明一样也会被判成
     * 「变了」，白推一次 —— 而「没变就不推」正是省流量的关键。
     */
    stable(v) {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map((x) => this.stable(x)).join(',') + ']';
      return '{' + Object.keys(v).sort().map((k) =>
        JSON.stringify(k) + ':' + this.stable(v[k])).join(',') + '}';
    },

    // 每个文件当前该长什么样。凭据永远不在里面（白名单式）
    fileBody(name) {
      if (name === 'meta.json') return { v: 1, tagPool: DB.d.tagPool, site: DB.d.site };
      return { v: 1, data: DB.d[name.replace(/\.json$/, '')] || {} };
    },
    fileText(name) { return this.stable(this.fileBody(name)); },

    // 合并：同一条记录谁的 updatedAt 新就留谁
    mergeMap(local, remote) {
      const out = Object.assign({}, local);
      for (const k in remote) {
        const l = out[k], r = remote[k];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) out[k] = r;
      }
      return out;
    },

    applyFile(name, obj) {
      if (!obj || obj.v !== 1) throw new Error('数据格式不认识');
      if (name === 'meta.json') {
        DB.d.tagPool = [...new Set([...DB.d.tagPool, ...(obj.tagPool || [])])];
        if (obj.site && !Object.keys(DB.d.site).length) DB.d.site = obj.site;
        return;
      }
      const k = name.replace(/\.json$/, '');
      if (!COLLECTIONS.includes(k)) return;
      DB.d[k] = this.mergeMap(DB.d[k], obj.data || {});
    },

    // v1.7 及以前的整包格式（云端老文件、以及「粘贴导入」都走这里）
    applyLegacy(obj) {
      if (!obj || obj.v !== 1) throw new Error('数据格式不认识');
      COLLECTIONS.forEach((k) => { DB.d[k] = this.mergeMap(DB.d[k], obj[k] || {}); });
      DB.d.tagPool = [...new Set([...DB.d.tagPool, ...(obj.tagPool || [])])];
      if (obj.site && !Object.keys(DB.d.site).length) DB.d.site = obj.site;
    },

    // 合并完统一做的收尾
    afterMerge() {
      DB.migrateLegacyProgress();   // 老设备推上来的进度还塞在书记录里
      DB.dedupeBmks();              // 两台设备在同一位置各加过书签
    },

    // 导出/导入用的整包格式，保持不变
    snapshot() {
      const snap = { v: 1, tagPool: DB.d.tagPool, site: DB.d.site, savedAt: now() };
      COLLECTIONS.forEach((k) => { snap[k] = DB.d[k]; });
      return snap;
    },
    apply(remote) { this.applyLegacy(remote); this.afterMerge(); },

    /*
     * 一轮同步：逐文件拉 → 逐条比时间戳合并 → 只把「变了的文件」推回去。
     * 某一边挂掉不影响另一边，各报各的成败。
     */
    async run(silent) {
      if (this.busy) return;
      const active = Object.entries(Backends).filter(([, b]) => b.ready());
      if (!active.length) { if (!silent) toast('还没配置任何云端喵'); return; }
      this.busy = true;
      if (!silent) toast('同步中…', 0);

      const errs = [], oks = [];
      const files = SYNC_FILES();
      const fail = (key, label, msg) => {
        errs.push(`${label}：${msg}`);
        DB.d.status[key] = { ok: false, ts: now(), err: msg };
      };

      try {
        // 0) 文件夹不在就建（坚果云要，GitHub 不用）。建不出来的这一边直接跳过
        const usable = [];
        for (const [key, b] of active) {
          try { await b.ensureDir(); usable.push([key, b]); }
          catch (e) { fail(key, b.label, e.message); }
        }

        // 1) 逐文件拉取合并。记下每边拿到的原文，第 2 步据此判断要不要推
        const got = {};
        for (const [key, b] of usable) {
          got[key] = {};
          let any = false;
          for (const f of files) {
            try {
              const r = await b.get(f);
              if (r.missing) { got[key][f] = null; continue; }
              got[key][f] = r.text;
              any = true;
              if (r.text) this.applyFile(f, JSON.parse(r.text));
            } catch (e) { got[key][f] = undefined; fail(key, b.label + ' ' + f, e.message); }
          }
          // 分表文件一个都没有 → 可能是 v1.7 及以前的整包数据，并进来
          if (!any && b.getLegacy) {
            try {
              const r = await b.getLegacy();
              if (!r.missing && r.text) this.applyLegacy(JSON.parse(r.text));
            } catch (e) { /* 老文件没有就算了，不算错 */ }
          }
        }
        this.afterMerge();

        // 2) 只推「和拉下来那份不一样」的文件
        for (const [key, b] of usable) {
          let ok = true, pushed = 0;
          for (const f of files) {
            const text = this.fileText(f);
            if (got[key] && got[key][f] === text) continue;   // 没变，省一次请求
            try { await b.put(f, text); pushed++; }
            catch (e) { ok = false; fail(key, b.label + ' ' + f, e.message); }
          }
          if (ok) {
            oks.push(b.label + (pushed ? `(${pushed})` : ''));
            DB.d.status[key] = { ok: true, ts: now(), err: '' };
          }
        }

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
  //    **书 ID = threadId，章 ID = postId**（v1.0 把这两个搞混过，见 _mig1）。
  //    页面结构对着线上 DOM 逐条校验过，完整版在 DEVELOPING.md「站点真实结构」。
  //    网站改版 / 换镜像域名时退回下面那套通用启发式 + 手动校准。
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
      /*
       * 只认真正的目录项：手机版是 btn-block 按钮、桌面版在 table 里。
       * 不能笼统地用 a[href*="/posts/"] —— 书籍介绍页的移动端容器里还塞了
       * 「总字数/阅读数」信息栏，那里也有一个 /posts/ 链接，会让章节数多算一条
       * （实测介绍页 47、目录列表页 46，差的就是它）。
       */
      catalogLink: 'a[class*="btn-block"][href*="/posts/"], table a[href*="/posts/"]',
      // 「有更新」不看站点自己那个 newchapter-badge —— 实际用起来经常不准。
      // 章节数由脚本自己数目录得出（点「查新章」时会抓一次目录页，见 checkUpdates）
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
     * 本页所有「章节」块。两种排版都要认：
     *   A) /threads/{tid}  一页多章，标题是 .text-center > strong > a[/posts/…]。
     *                      同页混着回帖，回帖没有标题行，据此排除
     *   B) /posts/{pid}    单章页，标题是 strong.h5（h3 是章节号）、没有链接。
     *                      同页的回帖也有 .main-text/#full{id}，所以只认 URL 那一条
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
        let title = '';
        if (titleEl) {
          // 排版 A 的标题区只有章节号（比如「2」），章节名不在这里
          title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
        } else if (only) {
          // 排版 B：h3 是章节号、h5 是章节名 —— 两个都要，拼起来才认得出是哪章
          const hs = [...el.querySelectorAll('.text-center strong')]
            .map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((x) => x && x !== '.');
          titleEl = el.querySelector('.text-center strong.h5') ||
                    el.querySelector('.text-center strong');
          title = [...new Set(hs)].join(' ');
        }
        if (!titleEl) continue;

        out.push({
          pid,
          el,
          title,
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

    /*
     * 书名。不能只靠 <title> —— 目录页的标题是「书名-目录列表 - 站点名」，
     * 直接切会把「-目录列表」当成书名存进去。所以优先读面包屑里那个书名链接，
     * 拿不到才退回 <title> 并削掉这类页面后缀。
     */
    bookTitle(tid) {
      if (tid) {
        const crumbs = document.querySelectorAll(this.SEL.bookCrumb(tid));
        const t = cleanText(crumbs[crumbs.length - 1]);
        if (t && t.length < 80) return t;
      }
      const t = (document.title || '').split(' - ')[0].trim()
        .replace(FW_PAGE_SUFFIX, '').trim();
      return t && t.length < 80 ? t : '';
    },
  };

  // 元素里的纯文字，**跳过我们自己插进去的角标**。章节名是从目录那一行学的，
  // 而那行尾巴上正挂着 [data-fw-badge] —— 不排掉就会把角标学进名字，还同步出去
  function cleanText(el) {
    if (!el) return '';
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 1) {
        if (n.dataset && n.dataset.fwBadge === '1') continue;
        out += cleanText(n);
      } else if (n.nodeType === 3) {
        out += n.nodeValue;
      }
      out += ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
  }

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
      this.bookTitle = FW.bookTitle(r.tid);

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
  // 存进数据里的必须是 /posts/{pid}，否则「我的标记」点过去会跳错地方
  const chapUrl = (cid) =>
    (Page.native && cid ? location.origin + '/posts/' + cid : location.href);

  /*
   * 记一个「阅读位置」。只有阅读进度用它，书签走 chapPos。
   *   cpct   章内读到百分之几（换字号/换设备都还算得准）
   *   anchor 视口顶部那句话的前 40 字，回来时优先靠它精准复位
   *   pct    整页百分比，最后的兜底
   */
  function capturePos(cid) {
    const pid = cid || Page.cid;
    const ch = Page.chapters.find((c) => c.pid === pid);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;

    let cpct = 0, anchor = '';
    if (ch) {
      const r = ch.el.getBoundingClientRect();
      if (r.height > 0) cpct = Math.min(1, Math.max(0, (80 - r.top) / r.height));
    }
    const scope = ch ? ch.body : Page.contentEl;
    if (scope) {
      for (const el of scope.children) {
        const r = el.getBoundingClientRect();
        if (r.bottom > 60 && r.top < window.innerHeight * 0.5) {
          const t = (el.textContent || '').replace(/\s+/g, '').trim();
          if (t.length >= 8) { anchor = t.slice(0, 40); break; }
        }
      }
    }
    // 章节名优先用「更全的那个」：正文页标题区只有章节号，
    // 而逛目录时学下来的名字带章节名，那个才认得出是哪一章
    const onPage = ch ? ch.title : Page.title;
    const stored = (DB.chap(Page.bid, pid, false) || {}).title;
    const title = (stored || '').length > (onPage || '').length ? stored : onPage;

    /*
     * 章节序号**每次都重算**，算不出来就明确写 null。
     * 踩过的坑：setProg 是 Object.assign 合并，原来「算不出就不写」，
     * 于是换章之后旧序号原地活下来，读第 1 章却显示成十几章。
     */
    return {
      bid: Page.bid, cid: pid,
      title,
      url: chapUrl(pid),
      pct, cpct, anchor, ts: now(),
      no: DB.chapNo(Page.bid, pid),
    };
  }

  // ==========================================================================
  // 5. 阅读进度
  // ==========================================================================
  const Progress = {
    capture() {
      if (Page.type !== 'chapter' || !Page.bid || !Page.cid) return null;
      return capturePos(Page.cid);
    },
    record() {
      const p = this.capture();
      if (!p) return;
      // 只有书名/地址这类真变了才动书记录（理由见 DB.prog 上面那段）
      DB.setProg(Page.bid, p);
      const b = DB.book(Page.bid, true);
      let dirty = false;
      if (!b.title && Page.bookTitle) { b.title = Page.bookTitle; dirty = true; }
      // 书记录被软删过的话要救回来 —— 不然详情页显示着「上次读到」，
      // 「我的标记」里却一本都不列（出过这个问题）
      if (b.deleted) { b.deleted = false; dirty = true; }
      if (dirty) DB.touch(b);
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

  // 跨页跳转的「接力棒」：目标章不在本页时先把位置寄存在这儿，
  // 落地页读出来再复位。用 sessionStorage 是因为它不参与同步、关标签页就没了
  const JUMP_KEY = '__fw_jump__';

  /*
   * 该跳到哪个地址。认得出章 ID 就一律用 /posts/{cid} —— 存量数据里的 url
   * 不可信（v1.0 把书籍主页存成了进度地址，点了等于原地刷新），
   * 而 ?page=N 会随作者更新漂掉。只有通用兜底模式才退回用存下来的 url。
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

  // 书签的「位置」就是哪一章：章 id + 章节名 + 章节固定链接，没有章内进度
  function chapPos(cid) {
    const pid = cid || Page.cid;
    if (!pid) return null;
    const ch = Page.chapters.find((c) => c.pid === pid);
    // 章节名优先用「更全的那个」：正文页标题区只有章节号，
    // 而逛目录时学下来的名字带章节名，那个才认得出是哪一章
    const onPage = ch ? ch.title : Page.title;
    const stored = (DB.chap(Page.bid, pid, false) || {}).title;
    const title = (stored || '').length > (onPage || '').length ? stored : onPage;
    return { bid: Page.bid, cid: pid, title, url: chapUrl(pid), ts: now() };
  }

  // 加 / 取消书签。一章最多一条，所以在同一章再点一次就是取消
  function toggleBmk(cid) {
    if (Page.type !== 'chapter' || !Page.bid) { toast('这一页没法加书签喵'); return false; }
    const pos = chapPos(cid);
    if (!pos) { toast('没认出是哪一章喵'); return false; }

    const dup = DB.bmkOfChap(Page.bid, pos.cid);
    if (dup) {
      dup.deleted = true;
      DB.touch(dup);
      toast('书签已取消');
    } else {
      Page.noteBook(Page.bid, Page.bookTitle, FW.catalogUrl(Page.bid), true);
      DB.addBmk(pos);
      toast(`🔖 已加书签：${pos.title || '本章'}`);
    }
    paintAll();
    if (sheet.classList.contains('on')) render();
    return true;
  }

  if (Page.type === 'chapter') {
    let t = null;
    addEventListener('scroll', () => {
      // 换章只更新「当前章」指针，不重绘面板
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
    const pg = DB.prog(Page.bid);
    const here = pg && Page.chapters.some((c) => c.pid === pg.cid);
    if (!jumpHere && here && (pg.cpct > 0.03 || pg.pct > 0.03) && window.scrollY < 50) {
      setTimeout(() => {
        const nm = pg.title ? `「${pg.title}」` : '上次的位置';
        confirmBar(`上次读到 ${nm} ${Math.round((pg.cpct || pg.pct) * 100)}%，回去吗？`,
          () => Progress.restore(pg));
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

  textarea, input[type=text], input[type=password] {
    width: 100%; border: 1.5px solid #e2e2e4; border-radius: 10px;
    padding: 10px 11px; font-size: 14px; background: #fafafa; color: #1c1c1e;
  }
  textarea { min-height: 76px; resize: vertical; line-height: 1.5; }
  .rvedit { min-height: 52px; margin-top: 7px; font-size: 12.5px; }

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
  .book .bt { font-size: 14px; font-weight: 600; margin-bottom: 5px;
    padding-right: 5.6em; position: relative; }
  /* 「什么时候数过章节」靠右挂在书名那一行，不跟进度挤同一行 */
  .book .bt .when { position: absolute; right: 0; top: 1px;
    font-size: 10.5px; font-weight: 400; color: #aeaeb2; white-space: nowrap; }
  .book .meta { font-size: 11.5px; color: #8e8e93; line-height: 1.7; }
  /* 章节名可能很长，单行 + 打点，别把卡片撑成两三行 */
  .book .meta.one { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .book .rv { font-size: 12.5px; color: #555; margin-top: 5px; line-height: 1.5;
    background: #fafafa; padding: 6px 8px; border-radius: 7px; }
  /* 书名后面那支铅笔：点开才展开编辑块，收着的时候一个字都不占 */
  .pen { cursor: pointer; margin-left: 5px; font-size: 12px; opacity: .75;
    vertical-align: middle; }
  .rvbox { margin-top: 8px; border-top: 1px dashed #e5e5e7; padding-top: 8px; }
  .rvbox .tags { margin-bottom: 2px; }
  .rvbox .t { font-size: 12px; padding: 4px 9px; }
  .chaplist { margin-top: 8px; border-top: 1px dashed #e5e5e7; padding-top: 7px; display: none; }
  .chaplist.on { display: block; }
  .chaplist a {
    display: block; font-size: 12.5px; color: #2b6cb0; text-decoration: none;
    padding: 5px 0; border-bottom: 1px solid #f5f5f7; line-height: 1.5;
  }
  .chaplist .n { color: #8e8e93; font-size: 11.5px; display: block; }

  /* 滑动开关。用伪元素做圆钮，省一层 DOM */
  .sw {
    float: right; width: 42px; height: 24px; border-radius: 12px;
    background: #d1d1d6; position: relative; cursor: pointer;
    transition: background .18s ease; flex: none;
  }
  .sw::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,.28);
    transition: transform .18s ease;
  }
  .sw.on { background: #34a853; }
  .sw.on::after { transform: translateX(18px); }

  .tabs { display: flex; gap: 6px; margin-bottom: 13px; }
  .tabs button {
    flex: 1; padding: 8px 0; border: none; border-radius: 9px;
    background: #f0f0f2; color: #6b6b70; font-size: 13px;
  }
  .tabs button.on { background: #e8554e; color: #fff; font-weight: 600; }

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

  // 'ctx' = 当前这本书 | 'all' = 我的标记 | 'cfg' = 同步设置
  let view = 'ctx';
  function openSheet(v) { view = v || 'ctx'; render(); mask.classList.add('on'); sheet.classList.add('on'); }
  function closeSheet() {
    mask.classList.remove('on'); sheet.classList.remove('on');
    editing = null;    // 下次打开不要还挂着上次那个展开的编辑框
  }
  // 页面上各处入口统一走这里
  function openView(v) { openSheet(v === 'book' ? 'ctx' : v); }
  mask.onclick = closeSheet;
  $('.cls').onclick = closeSheet;
  function refreshUI() { if (sheet.classList.contains('on')) render(); paintAll(); }

  // ==========================================================================
  // 7. 面板渲染
  // ==========================================================================
  // 认得出书就渲染「这本书」。章节那点事（标记 / 书签）全在正文里内联做完了，
  // 不需要单独的章节面板
  function render() {
    if (view === 'all') return renderAll();
    if (view === 'cfg') return renderCfg();
    if (view === 'tags') return renderTags();
    if (Page.bid) return renderBook();
    return renderAll();
  }

  // 认得出是哪本书时，各处面板都留一个「这本书」的入口
  const bookBtn = () =>
    (Page.bid ? '<button class="btn g" data-go="book">📖 这本书</button>' : '');

  function navBtns(extra = '') {
    return `<div class="btns" style="margin-top:18px">
      ${extra}
      <button class="btn g" data-go="all">📚 我的标记</button>
      <button class="btn g" data-go="cfg">⚙️ 同步设置</button>
    </div>`;
  }

  // ---- 标签池：改名 / 删除 ----
  // 改名要改到所有书身上，所以单开一页，别混在「挑标签」那个格子里点错
  function renderTags() {
    const pool = DB.d.tagPool;
    const used = (t) => DB.liveBooks().filter((b) => (b.tags || []).includes(t)).length;
    sTitle.textContent = '管理标签';
    sSub.textContent = pool.length ? `${pool.length} 个` : '';
    sBody.innerHTML = `
      <div class="hint" style="margin-bottom:12px">
        改名会**同时改掉所有书**身上那一份，删除同理。打错字在这儿修就行喵。
      </div>
      ${pool.length ? pool.map((t) => `<div class="book">
        <div class="bt">${esc(t)} <span class="n" style="color:#8e8e93;font-weight:400">${used(t)} 本在用</span></div>
        <div class="btns" style="margin-top:6px">
          <button class="btn g sm" data-tagren="${esc(t)}">改名</button>
          <button class="btn g sm" data-tagdel="${esc(t)}">删除</button>
        </div>
      </div>`).join('') : '<div class="empty">还没有自定义标签喵</div>'}
      ${navBtns(bookBtn())}
    `;
  }

  // 网址里没认出书/章编号时的兜底提示
  function renderUnknown(what) {
    sTitle.textContent = '没认出这一页';
    sSub.textContent = '';
    sBody.innerHTML = `<div class="empty">没能从网址里认出${what}编号喵。<br><br>
      去这本书的<b>目录页</b>，从「⚙️ 同步设置」里点<b>重新校准</b>，<br>再点一下任意章节链接就能教会本喵。</div>${navBtns()}`;
  }

  // ---- 书签列表（书籍面板 / 我的标记 两处共用）----
  function bmkListHTML(list, emptyHint) {
    if (!list.length) return emptyHint ? `<div class="hint">${esc(emptyHint)}</div>` : '';
    return list.map((m) => `
      <div class="bmk">
        <div class="go" data-bmkgo="${esc(m.key)}">
          <span class="pill" style="background:#d98b00">🔖</span>
          ${esc(m.title || m.cid)}
        </div>
        <span class="bx">
          <button class="btn g sm" data-bmkdel="${esc(m.key)}">删</button>
        </span>
      </div>`).join('');
  }

  // ---- 这本书：书评 + 标签 + 继续阅读 + 书签 ----
  function renderBook() {
    if (!Page.bid) return renderUnknown('书籍');
    const b = DB.book(Page.bid, true);
    const pg = DB.prog(Page.bid);
    // note 已经不能再写了（章节内只留书签），但老数据里存量的备注还得认，
    // 不然以前写过的东西会凭空消失
    const marked = DB.chapsOf(Page.bid).filter((c) => c.mark || c.note);
    const bmks = DB.bmksOf(Page.bid);
    const pool = DB.d.tagPool;
    sTitle.textContent = b.title || Page.bookTitle || '这本书';
    sSub.textContent = [marked.length ? `已标 ${marked.length} 章` : '',
                        bmks.length ? `🔖 ${bmks.length}` : ''].filter(Boolean).join(' · ');
    sBody.innerHTML = `
      ${pg ? `<div class="row">
        <label>阅读进度（自动记的，会被覆盖）</label>
        <button class="btn" data-act="continue">▶ 继续读：${esc(pg.title || '上次的位置')} · ${Math.round((pg.cpct || pg.pct || 0) * 100)}%</button>
      </div>` : ''}
      <div class="row">
        <label>书签（手动加的，不会被覆盖）${bmks.length ? ' · ' + bmks.length + ' 个' : ''}</label>
        ${bmkListHTML(bmks, '这本书还没有书签喵。读正文时点章节下面那个 🔖 就能加。')}
      </div>
      <div class="row">
        <label>书籍标签（点一下选中／取消）</label>
        <div class="tags">
          ${pool.map((t) => `<span class="t ${b.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}
          <span class="t add" data-act="newtag">＋ 新标签</span>
          <span class="t add" data-tagmgr>✎ 管理</span>
        </div>
      </div>
      <div class="row">
        <label>书评</label>
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
  // 三件事用法完全不同：书签是「回到某处」，进度是「接着读」，书评是「这书怎么样」。
  // 所以拆成三个 subtab，搜索框在当前 tab 内生效
  const ALL_TABS = [['prog', '▶ 进度'], ['bmk', '🔖 书签'], ['rate', '⭐ 书评']];
  let allTab = 'prog';   // 默认看进度：进来最常想知道的是「上次读到哪」
  // 哪本书的「✏️ 写书评 / 打标签」编辑框是展开的（一次只开一个）。
  // 存成状态而不是直接 toggle class：点标签会重绘列表，重绘完得还开着
  let editing = null;

  function renderAll(kw) {
    if (kw !== undefined) searchKw = kw;
    sTitle.textContent = '我的标记';
    sBody.innerHTML = `
      <div class="tabs">
        ${ALL_TABS.map(([k, label]) =>
          `<button data-tab="${k}" class="${allTab === k ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      <div class="row"><input type="text" data-search placeholder="搜书名 / 章节 / 书评 / 标签…"
        value="${esc(searchKw)}" autocapitalize="off" autocorrect="off"></div>
      <div data-list></div>
      ${navBtns(bookBtn())}
    `;
    paintList();
  }

  const bookName = (b) => esc((b && b.title) || ('（未命名 · ' + (b ? b.id : '') + '）'));
  // 「上次数章节的时间」这种辅助信息：只要 月/日 时:分，靠右挂在书名那行
  const when = (ts) => new Date(ts).toLocaleString('zh-CN',
    { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  // 最近有动静的排最前，三个 tab 一致
  const booksByRecent = () =>
    DB.liveBooks().sort((a, b) => DB.lastActive(b.id) - DB.lastActive(a.id));
  const emptyBox = (kw, hint) =>
    `<div class="empty">${kw ? '没搜到喵' : hint}</div>`;

  function paintList() {
    const box = sBody.querySelector('[data-list]');
    if (!box) return;
    const kw = (searchKw || '').toLowerCase();
    if (allTab === 'bmk') return paintBmkTab(box, kw);
    if (allTab === 'prog') return paintProgTab(box, kw);
    return paintRateTab(box, kw);
  }

  // ---- 书名后面那支铅笔，和它展开的编辑块 ----
  // 进度和书评两个 tab 共用：在哪儿看见这本书就能在哪儿顺手写。
  // 收起来时不占地方，所以进度那一栏还是只讲进度
  const penHTML = (bid) =>
    `<span class="pen" data-pen="${esc(bid)}" title="写书评 / 打标签">✏️</span>`;

  function rvBoxHTML(b) {
    if (editing !== b.id) return '';
    return `<div class="rvbox">
      <div class="tags">
        ${DB.d.tagPool.map((t) => `<span class="t ${b.tags.includes(t) ? 'on' : ''}"
          data-btag="${esc(t)}" data-bk="${esc(b.id)}">${esc(t)}</span>`).join('')}
        <span class="t add" data-newtag="${esc(b.id)}">＋ 新标签</span>
        <span class="t add" data-tagmgr>✎ 管理</span>
      </div>
      <textarea class="rvedit" data-rv="${esc(b.id)}"
        placeholder="这本书读下来感觉如何…（边写边存）">${esc(b.review)}</textarea>
      <div class="btns" style="margin-top:6px">
        <button class="btn sm" data-pendone="${esc(b.id)}">写好了</button>
      </div>
    </div>`;
  }

  // 已经写下的书评，收起编辑框时就是一段纯文本
  const rvTextHTML = (b) =>
    (b.review && editing !== b.id
      ? `<div class="rv">${esc(b.review).replace(/\n/g, '<br>')}</div>` : '');

  const tagPills = (b) => (b.tags || [])
    .map((t) => `<span class="pill" style="background:#5a6b8c">${esc(t)}</span>`).join('');

  // ---- tab 1：书签 ----
  function paintBmkTab(box, kw) {
    const rows = [];
    let total = 0;
    for (const b of booksByRecent()) {
      const bs = DB.bmksOf(b.id);
      total += bs.length;
      if (!bs.length) continue;
      const nameHit = (b.title || '').toLowerCase().includes(kw);
      const list = !kw || nameHit ? bs : bs.filter((m) =>
        ((m.title || '') + (m.anchor || '')).toLowerCase().includes(kw));
      if (!list.length) continue;
      rows.push(`<div class="book" data-bid="${esc(b.id)}">
        <div class="bt">${bookName(b)} <span class="n">🔖 ${list.length}</span></div>
        ${bmkListHTML(list)}
      </div>`);
    }
    sSub.textContent = total ? `共 ${total} 个书签` : '';
    box.innerHTML = rows.length ? rows.join('')
      : emptyBox(kw, '还没有书签喵～<br>读正文时点章节下面那个 🔖');
  }

  // ---- tab 2：阅读进度 ----
  /*
   * 列的是**进度记录本身**，不是「书里有进度的那些」—— 书记录和进度是两张表，
   * 书记录可能还没建或者被软删过（出过这个问题：详情页显示着「上次读到」，
   * 我的标记里却一本都没有）。拿不到书记录就用个占位名字，照样能继续读。
   *
   * 排序按**进度自己的 updatedAt**，不用 lastActive —— 后者会被「查了一次新章」
   * 这类跟阅读无关的改动顶上去，点一下刷新顺序就全乱了。
   */
  function paintProgTab(box, kw) {
    const reading = [], finished = [];
    for (const p of Object.values(DB.d.prog)) {
      if (!p || p.deleted || !p.bid) continue;
      const b = DB.book(p.bid, false) || { id: p.bid, title: '', tags: [], review: '' };
      if (kw && !((b.title || '') + (p.title || '')).toLowerCase().includes(kw)) continue;
      (DB.isFinished(p.bid) ? finished : reading).push([b, p]);
    }
    const byRead = (x, y) => (y[1].updatedAt || 0) - (x[1].updatedAt || 0);
    reading.sort(byRead); finished.sort(byRead);

    // 「第几章/共几章」里的总数是**上次数目录时**的，不是实时的
    // （正文页上算不出全书章节数）。所以标「有新章」而不是「有更新」，别把话说满
    const row = ([b, p], fin) => {
      const pct = Math.round((p.cpct || p.pct || 0) * 100);
      const no = p.no, total = b.chapTotal;
      const hasNew = !fin && no && total && no < total;
      const at = b.chapCheckedAt || b.chapSeenAt;
      return `<div class="book" data-bid="${esc(b.id)}">
        <div class="bt">${bookName(b)}
          ${no && total ? `<span class="pill" style="background:#5a6b8c">${no}/${total}</span>` : ''}
          ${hasNew ? `<span class="pill" style="background:#e8554e">▲ 有新章 ${total - no}</span>` : ''}
          ${fin ? '<span class="pill" style="background:#34a853">✓ 读完</span>' : ''}
          ${penHTML(b.id)}
          ${at ? `<span class="when" title="上次数章节的时间">🕘 ${when(at)}</span>` : ''}
        </div>
        <div class="meta one">▶ 读到「${esc(p.title || '某一章')}」 ${pct}%</div>
        ${rvBoxHTML(b)}
        <div class="btns" style="margin-top:8px">
          <button class="btn sm" data-jump="${esc(p.url || '')}">继续读</button>
          <button class="btn g sm" data-jump="${esc(DB.bookUrl(b.id))}">书籍主页</button>
          <button class="btn g sm" data-doneread="${esc(b.id)}"
            data-on="${b.doneRead ? '1' : ''}">${b.doneRead ? '↩ 没读完' : '✓ 标已读完'}</button>
          <button class="btn g sm" data-progdel="${esc(b.id)}">清除进度</button>
        </div>
      </div>`;
    };

    sSub.textContent = [
      reading.length ? `${reading.length} 本在读` : '',
      finished.length ? `${finished.length} 本读完` : '',
    ].filter(Boolean).join(' · ');

    const parts = [];
    if (reading.length) {
      parts.push(`<div class="btns" style="margin-bottom:6px">
        <button class="btn g sm" data-act="chkupd">🔄 查一下有没有新章</button>
      </div>
      <div class="hint" style="margin:0 0 12px">
        章节数是脚本<b>自己去数目录</b>得出的（站内那个「有更新」标记不太准）。<br>
        只查<b>在读</b>的书 —— 标了完结的、以及你标过「已读完」的都不查。
      </div>`);
    }
    parts.push(...reading.map((x) => row(x, false)));
    if (finished.length) {
      parts.push('<div class="hint" style="margin:14px 0 4px">读完了</div>');
      parts.push(...finished.map((x) => row(x, true)));
    }
    box.innerHTML = parts.length ? parts.join('')
      : emptyBox(kw, '还没有阅读进度喵～<br>读几章就会自动记下来');
  }

  /*
   * ---- tab 3：书评 ----
   * 只列「真的评过」的书：打过标签、写过书评、或者标过章节。光有进度不算 ——
   * 那是进度 tab 的事，堆在这里只会把真写过的东西埋掉。
   * 想给还没评过的书补一句：去进度 tab，点书名后那支 ✏️。
   */
  function paintRateTab(box, kw) {
    const rows = [];
    let total = 0;
    for (const b of booksByRecent()) {
      const cs = DB.chapsOf(b.id).filter((c) => c.mark || c.note);
      const rated = (b.tags || []).length || b.review || cs.length;
      // 正在写的那本先留着，不然第一个字还没打完它就自己消失了
      if (!rated && editing !== b.id) continue;
      total++;
      const hit = !kw ||
        (b.title || '').toLowerCase().includes(kw) ||
        (b.review || '').toLowerCase().includes(kw) ||
        b.tags.some((t) => t.toLowerCase().includes(kw)) ||
        cs.some((c) => ((c.title || '') + (c.note || '')).toLowerCase().includes(kw));
      if (!hit) continue;

      const cnt = { good: 0, ok: 0, skip: 0 };
      cs.forEach((c) => { if (c.mark) cnt[c.mark]++; });
      // 标签和标记数都跟在书名后面。书评写好了就是一段纯文本，
      // 想改再点铅笔 —— 一直摆个输入框在那儿，列表全是框，读起来累
      rows.push(`<div class="book" data-bid="${esc(b.id)}">
        <div class="bt">${bookName(b)}
          ${tagPills(b)}
          ${Object.entries(cnt).filter(([, v]) => v).map(([k, v]) =>
            `<span class="pill" style="background:${MARKS[k].color}">${MARKS[k].label} ${v}</span>`).join('')}
          ${penHTML(b.id)}
        </div>
        ${rvTextHTML(b)}
        ${rvBoxHTML(b)}
        <div class="btns" style="margin-top:8px">
          <button class="btn g sm" data-jump="${esc(DB.bookUrl(b.id))}">书籍主页</button>
          ${cs.length ? `<button class="btn g sm" data-toggle>标记章节 ${cs.length}</button>` : ''}
          <button class="btn g sm" data-ratedel="${esc(b.id)}">清除书评</button>
        </div>
        <div class="chaplist">
          ${cs.sort((a, c) => (c.updatedAt || 0) - (a.updatedAt || 0)).map((c) => `
            <a href="${esc(c.url)}">
              ${c.mark ? `<span class="pill" style="background:${MARKS[c.mark].color}">${MARKS[c.mark].label}</span>` : ''}
              ${esc(c.title || c.cid)}
              ${c.note ? `<span class="n">📝 ${esc(c.note)}</span>` : ''}
            </a>`).join('')}
        </div>
      </div>`);
    }
    sSub.textContent = total ? `${total} 本评过` : '';
    box.innerHTML = rows.length ? rows.join('')
      : emptyBox(kw, '还没写过书评、也没打过标签喵～<br>点书名后面那支 ✏️ 就能写');
  }

  /*
   * 一键自查。同步失败只给一行状态码，看不出哪儿不对，所以把最容易错的几件事
   * 直接查给用户看：GitHub 能不能读；坚果云账号下**真实存在**的同步文件夹有哪些
   * （地址里文件夹名写错是头号原因），以及服务器自报的原因（如 AccountExpired）。
   */
  let lastDiag = '';
  async function runDiag() {
    const box = sBody.querySelector('[data-diag]');
    if (!box) return;
    const line = (t) => `<div style="margin:3px 0">${t}</div>`;
    box.innerHTML = '<div class="hint">检查中…</div>';
    const out = [];
    // 诊断结论要写回状态，否则上面那行还挂着「上次同步」的旧报错，自相矛盾
    const mark = (key, ok, err) => { DB.d.status[key] = { ok, ts: now(), err: err || '' }; };

    // ---- GitHub 私有仓库 ----
    if (Backends.repo.ready()) {
      try {
        const r = await Backends.repo.get('meta.json');
        mark('repo', true, '');
        out.push(line(r.missing
          ? '✅ GitHub：仓库和文件夹能访问，数据文件还没建（首次同步会自动创建）'
          : '✅ GitHub：读写正常'));
      } catch (e) {
        mark('repo', false, e.message);
        out.push(line('❌ GitHub：' + esc(e.message)));
      }
    } else {
      out.push(line('— GitHub：没配或已关闭'));
    }

    // ---- 坚果云 ----
    if (Backends.dav.ready()) {
      try {
        const dir = Backends.dav.dir();
        // 1) 先看账号下到底有哪些「同步文件夹」—— 地址里第一层写错是头号原因
        const root = new URL(dir).origin + '/dav/';
        const r = await GMx.req(root, {
          method: 'PROPFIND',
          headers: Object.assign({ Depth: '1' }, Backends.dav.hdr()),
        });
        if (r.status >= 300) {
          mark('dav', false, Backends.dav.err(r.status, r.text));
          out.push(line('❌ 坚果云：' + esc(Backends.dav.err(r.status, r.text))));
        } else {
          const names = [...String(r.text).matchAll(/<[^>]*href>(.*?)<\/[^>]*href>/gi)]
            .map((m) => decodeURIComponent(m[1]).replace(/\/+$/, '').split('/').pop())
            .filter((x) => x && x !== 'dav');
          const uniq = [...new Set(names)];
          const first = decodeURIComponent(new URL(dir).pathname)
            .split('/').filter(Boolean)[1] || '';
          out.push(line('✅ 坚果云：连得上。你的同步文件夹：<b>' +
            uniq.map(esc).join('</b>、<b>') + '</b>'));
          out.push(uniq.includes(first)
            ? line(`✅ 地址第一层用的「${esc(first)}」对得上`)
            : line(`❌ 地址第一层写的是「${esc(first)}」，不在上面的列表里 —— 照着改`));

          // 2) 子文件夹不存在就建出来（这一步本身也是在验写权限）
          await Backends.dav.ensureDir();
          out.push(line('✅ 坚果云：文件夹就绪（不存在的子文件夹已自动创建）'));

          // 3) 真写一次再删掉 —— 账户过期/流量用尽这类只有写的时候才报
          const probe = 'fw-marks-selftest.json';
          await Backends.dav.put(probe, '{"selftest":true}');
          await GMx.req(dir + probe, { method: 'DELETE', headers: Backends.dav.hdr() });
          mark('dav', true, '');
          out.push(line('✅ 坚果云：写权限正常'));
        }
      } catch (e) {
        mark('dav', false, e.message);
        out.push(line('❌ 坚果云：' + esc(e.message)));
      }
    } else {
      out.push(line('— 坚果云：没配或已关闭'));
    }

    lastDiag = `<div class="hint" style="background:#f7f7f9;padding:10px;
      border-radius:9px;margin-top:10px;line-height:1.8">${out.join('')}</div>`;
    await DB.saveNow();
    render();   // 重渲染让上面那行状态跟着更新；lastDiag 会被一起画回去
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
        <label>① GitHub 私有仓库　${c.repoOn ? st('repo') : ''}
          <span class="sw ${c.repoOn ? 'on' : ''}" data-backon="repo" role="switch"
            aria-checked="${!!c.repoOn}" title="${c.repoOn ? '已启用，点一下关闭' : '已关闭，点一下启用'}"></span>
        </label>
        ${!c.repoOn ? '' : `
        <input type="password" data-token placeholder="Token：github_pat_…（细粒度）" value="${esc(c.token)}">
        <input type="text" data-repo placeholder="仓库：owner/仓库名" value="${esc(c.repo)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="text" data-repodir placeholder="文件夹（默认 fw-marks，留空＝仓库根目录）" value="${esc(c.repoDir)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="text" data-repobranch placeholder="分支（留空＝仓库默认分支）" value="${esc(c.repoBranch)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <div class="hint">
          GitHub → Settings → Developer settings → <b>Fine-grained tokens</b> →
          Repository access 选 <b>Only select repositories</b> 挑你那个<b>私有</b>仓库 →
          Permissions 里只给 <b>Contents: Read and write</b> 就够喵。<br>
          填<b>文件夹</b>（留空＝仓库根目录），里面的文件由脚本自己管，不存在会自动创建。<br>
          <b>别用公共仓库</b> —— 这里存的是你读了什么、标了什么。
          ${c.repo ? `<br>👉 <a href="https://github.com/${esc(c.repo)}" target="_blank">打开这个仓库</a>` : ''}
        </div>`}
      </div>

      <div class="row">
        <label>② 坚果云 WebDAV　${c.davOn ? st('dav') : ''}
          <span class="sw ${c.davOn ? 'on' : ''}" data-backon="dav" role="switch"
            aria-checked="${!!c.davOn}" title="${c.davOn ? '已启用，点一下关闭' : '已关闭，点一下启用'}"></span>
        </label>
        ${!c.davOn ? '' : `
        <input type="text" data-davdir placeholder="WebDAV 文件夹地址（要以 / 结尾）" value="${esc(c.davDir)}">
        <input type="text" data-davuser placeholder="账号（坚果云注册邮箱）" value="${esc(c.davUser)}" style="margin-top:7px" autocapitalize="off" autocorrect="off">
        <input type="password" data-davpass placeholder="应用密码（不是登录密码！）" value="${esc(c.davPass)}" style="margin-top:7px">
        <div class="hint">
          坚果云 → 账户信息 → <b>安全选项</b> → 添加应用 → 生成的那串就是应用密码喵<br>
          （<b>不是登录密码</b>）。<br>
          填<b>文件夹</b>，不是文件：<code>…/dav/同步文件夹/子文件夹/</code>（结尾带 /）。<br>
          里面的文件由脚本自己管（一个表一个文件，只推改过的那个，省流量）。<br>
          子文件夹<b>不存在会自动创建</b>；但 <code>…/dav/</code> 下的
          <b>第一层同步文件夹必须已经存在</b> —— 根目录只是它们的列表，写不进去。<br>
          WebDAV <b>不需要付费</b>，免费版就能用；免费版限的是流量
          （每月 1GB 上传 / 3GB 下载）和请求频率，不是功能。
        </div>`}
      </div>

      <div class="row">
        <label><input type="checkbox" data-auto ${c.autoSync ? 'checked' : ''}> 打开网页时自动后台同步（静默，失败不打扰）</label>
      </div>

      <div class="row">
        <label>查新章</label>
        <div class="hint">
          站点自己那个「有更新」标记不太准，所以章节数是脚本<b>自己去数目录</b>得出的。<br>
          这件事<b>只在你点的时候才做</b>，不后台偷跑：
          <b>📑 我的标记 → ▶ 进度 → 🔄 查一下有没有新章</b>。<br>
          只查在读、且没标完结的书。
        </div>
      </div>
      <div class="btns">
        <button class="btn" data-act="saveCfg">保存设置</button>
        <button class="btn g" data-act="syncNow">立即同步</button>
        <button class="btn g" data-act="diag">🔍 测试连接</button>
      </div>
      <div data-diag>${lastDiag}</div>
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
    const t = e.target.closest('[data-act],[data-go],[data-tag],[data-jump],[data-ratedel],' +
      '[data-toggle],[data-bmkgo],[data-bmkdel],[data-bmktoggle],[data-tab],' +
      '[data-progdel],[data-backon],[data-pen],[data-pendone],[data-btag],[data-newtag],' +
      '[data-doneread],[data-tagmgr],[data-tagren],[data-tagdel]');
    if (!t) return;

    // 某个云端的总开关：关掉就不参与同步，设置里也折叠起来不占地方
    if (t.dataset.backon) {
      const k = t.dataset.backon === 'repo' ? 'repoOn' : 'davOn';
      DB.d.cfg[k] = !DB.d.cfg[k];
      lastDiag = '';
      await DB.saveNow();
      toast(DB.d.cfg[k] ? '已启用' : '已关闭，不再参与同步');
      render();
      return;
    }

    // ---- 「我的标记」的三个 subtab ----
    if (t.dataset.tab) {
      flushRvBox();
      allTab = t.dataset.tab;
      editing = null;
      render();
      sBody.scrollTop = 0;
      return;
    }

    // 只重绘列表、不动整个面板，否则搜索框被换掉、iOS 键盘会闪。
    // 重绘前必须先 flushRvBox()：正在编辑的文字只在 DOM 里，一换就没了
    if (t.dataset.pen) {
      flushRvBox();
      editing = editing === t.dataset.pen ? null : t.dataset.pen;
      paintList();
      return;
    }
    if (t.dataset.pendone) {
      flushRvBox();
      editing = null;
      paintList(); paintAll();
      toast('记下了喵 ✓');
      return;
    }
    // 编辑块里的标签（指定哪本书，和「这本书」面板那套 data-tag 不同）
    if (t.dataset.btag) {
      flushRvBox();
      const b = DB.book(t.dataset.bk, false);
      if (!b) return;
      const tag = t.dataset.btag;
      b.tags = b.tags.includes(tag) ? b.tags.filter((x) => x !== tag) : [...b.tags, tag];
      DB.touch(b);
      paintList(); paintAll();
      return;
    }
    if (t.dataset.newtag) {
      flushRvBox();
      const b = DB.book(t.dataset.newtag, false);
      const v = prompt('新标签（比如：甜文 / 追更中 / 弃坑）');
      if (b && v && v.trim()) {
        DB.addTag(v.trim());
        if (!b.tags.includes(v.trim())) b.tags.push(v.trim());
        DB.touch(b);
        paintList(); paintAll();
      }
      return;
    }
    if (t.hasAttribute('data-tagmgr')) {
      flushRvBox();
      view = 'tags'; render(); sBody.scrollTop = 0;
      return;
    }
    if (t.dataset.tagren) {
      const from = t.dataset.tagren;
      const to = prompt('改成什么？', from);
      if (to !== null && to.trim() && to.trim() !== from) {
        const n = DB.renameTag(from, to.trim());
        toast(`改好了，顺手改了 ${n} 本书上的 ✓`);
        render(); paintAll();
      }
      return;
    }
    if (t.dataset.tagdel) {
      const tag = t.dataset.tagdel;
      confirmBar(`删掉标签「${tag}」？所有书上这个标签也一起去掉`, () => {
        const n = DB.renameTag(tag, '');
        toast(`删了，顺手清了 ${n} 本书上的`);
        render(); paintAll();
      });
      return;
    }

    // 手动标「已读完 / 还没读完」。进度一点都不动，只是换个归类
    if (t.dataset.doneread) {
      const on = !t.dataset.on;
      DB.setDoneRead(t.dataset.doneread, on);
      toast(on ? '标成已读完了喵 ✓' : '挪回在读了');
      render(); paintAll();
      return;
    }

    // 单独清掉某本书的阅读进度（书和标记都留着）
    if (t.dataset.progdel) {
      const pg = DB.prog(t.dataset.progdel);
      if (pg) { pg.deleted = true; DB.touch(pg); }
      toast('已清除这本的进度');
      render(); paintAll();
      return;
    }

    // ---- 书签 ----
    if (t.dataset.bmkgo) {
      const m = DB.d.bmks[t.dataset.bmkgo];
      // 只认「哪一章」，落地在章首。老数据身上可能还留着 cpct/anchor，
      // 这里故意不传过去 —— 不然新旧书签的跳转行为会不一样
      if (m && !m.deleted) jumpTo({ bid: m.bid, cid: m.cid, title: m.title, url: m.url });
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

    if (t.dataset.go) {
      flushRvBox();
      editing = null;
      view = t.dataset.go === 'book' ? 'ctx' : t.dataset.go;
      render();
      sBody.scrollTop = 0;
      return;
    }
    if (t.dataset.jump) { location.href = t.dataset.jump; return; }
    if (t.hasAttribute('data-toggle')) { t.closest('.book').querySelector('.chaplist').classList.toggle('on'); return; }
    /*
     * 清除「书评」= 书籍标签 + 书评 + 章节标记。
     * 书签和阅读进度**不动** —— 三者互相独立，各自在自己那个 tab 里删。
     */
    if (t.dataset.ratedel) {
      const b = DB.d.books[t.dataset.ratedel];
      if (!b) return;
      confirmBar(`清除「${b.title || b.id}」的标签、书评和章节标记？书签和进度不动`, () => {
        b.tags = []; b.review = '';
        DB.touch(b);
        DB.chapsOf(b.id).forEach((c) => { c.deleted = true; c.updatedAt = now(); });
        DB.save(); editing = null; render(); paintAll(); toast('已清除这本的书评');
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
      case 'continue':
        jumpTo(DB.prog(Page.bid));
        break;
      case 'saveCfg': {
        // 关掉的那一段是折叠起来的，输入框根本不在 DOM 里 ——
        // 拿不到就跳过那一项，别把已有配置清空、更别直接抛错
        const v = (sel) => {
          const el = sBody.querySelector(sel);
          return el ? el.value.trim() : undefined;
        };
        const set = (key, val, dflt) => {
          if (val !== undefined) DB.d.cfg[key] = val || dflt || '';
        };
        set('token', v('[data-token]'));
        set('repo', v('[data-repo]'));
        set('repoDir', v('[data-repodir]'));
        Backends.repo._sha = {};     // 换了文件夹，旧的文件版本号全作废
        set('repoBranch', v('[data-repobranch]'));
        Backends.repo._sha = null;   // 换了仓库/路径，旧的文件版本号就作废了
        lastDiag = '';               // 配置变了，上次的诊断结论就不作数了
        // 文件夹地址补上结尾的斜杠，不然拼出来的文件名会粘在一起
        const dd = v('[data-davdir]');
        if (dd !== undefined) DB.d.cfg.davDir = dd ? dd.replace(/\/*$/, '/') : '';
        set('davUser', v('[data-davuser]'));
        set('davPass', v('[data-davpass]'));
        const auto = sBody.querySelector('[data-auto]');
        if (auto) DB.d.cfg.autoSync = auto.checked;
        await DB.saveNow();
        const on = Object.values(Backends).filter((b) => b.ready()).length;
        toast(on === 2 ? '双备份已就绪喵 ✓' : on === 1 ? '已保存（只配了一个云端喵）' : '已保存');
        render();
        break;
      }
      case 'syncNow': await Sync.run(false); break;
      case 'diag': await runDiag(); break;
      case 'chkupd':
        await checkUpdates();   // 提示语由它自己报（要显示 3/12 这种进度）
        render();
        break;
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
  const rvTimers = {};
  // 边打边存。关键是**存完不能重绘面板** —— 一重绘正在打字的框就被换掉，
  // 光标和输入法都会丢。所以只 touch 数据 + 重画网页上的角标
  function saveReview(bid, text) {
    const b = DB.book(bid, false);
    if (!b || b.review === text) return;
    b.review = text;
    DB.touch(b);
    paintAll();          // 网页上的角标（有书评会显示 📝）跟着更新
  }

  // 重绘列表前把编辑框里还没落盘的文字存下来（点标签、点「写好了」、切 tab
  // 都会重绘）。一次只开一个编辑框，所以 querySelector 拿的就是那一个
  function flushRvBox() {
    const ta = sBody.querySelector('[data-rv]');
    if (!ta) return;
    const bid = ta.getAttribute('data-rv');
    clearTimeout(rvTimers[bid]);
    saveReview(bid, ta.value.trim());
  }
  sBody.addEventListener('input', (e) => {
    const rv = e.target.closest && e.target.closest('[data-rv]');
    if (rv) {
      const bid = rv.getAttribute('data-rv');
      clearTimeout(rvTimers[bid]);
      rvTimers[bid] = setTimeout(() => saveReview(bid, rv.value.trim()), 700);
      return;
    }
    if (!e.target.matches('[data-search]')) return;
    searchKw = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(paintList, 120); // 只重绘列表，输入框原地不动
  });
  // 失焦时立刻落一次，免得刚打完就切走、防抖还没到点
  sBody.addEventListener('focusout', (e) => {
    const rv = e.target.closest && e.target.closest('[data-rv]');
    if (!rv) return;
    const bid = rv.getAttribute('data-rv');
    clearTimeout(rvTimers[bid]);
    saveReview(bid, rv.value.trim());
  });

  // ==========================================================================
  // 9. 直接画在网页上的标记 —— 不点开插件也能一眼看到
  //    目录页每章后挂角标、书名后挂书籍标签和进度、正文页每章一条内联标记条。
  //    全部走内联样式，不受网站 CSS 影响；节点带 data-fw-* 便于原地更新
  // ==========================================================================

  /*
   * 重绘用的索引。不建索引的话每个章节链接都要全表扫一遍书签 ——
   * 一本 138 章的书一轮重绘就是两百多次全表扫描，手机上白烧电。
   * paintAll() 开头置空 + 懒构建，所以永远不会读到过期的。
   */
  let IDX = null;
  function idx() {
    if (IDX) return IDX;
    const byChap = new Map();   // '书|章' → [书签…]
    const byBook = new Map();   // 书 → [书签…]
    const marked = new Map();   // 书 → 标记过的章数
    for (const m of Object.values(DB.d.bmks)) {
      if (!m || m.deleted || !m.bid) continue;
      const k = m.bid + '|' + m.cid;
      if (!byChap.has(k)) byChap.set(k, []);
      if (!byBook.has(m.bid)) byBook.set(m.bid, []);
      byChap.get(k).push(m);
      byBook.get(m.bid).push(m);
    }
    for (const c of Object.values(DB.d.chaps)) {
      if (!c || c.deleted || !(c.mark || c.note)) continue;
      marked.set(c.bid, (marked.get(c.bid) || 0) + 1);
    }
    IDX = {
      bmksOfChap: (bid, cid) => byChap.get(bid + '|' + cid) || [],
      bmksOfBook: (bid) => byBook.get(bid) || [],
      markedCount: (bid) => marked.get(bid) || 0,
    };
    return IDX;
  }

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

  // 章节角标：标签色块 + 书签 + 「读到这里」（📝 是老数据里的备注）
  function chapBadgeHTML(c, isCur, nb) {
    const live = c && !c.deleted;
    const m = live && c.mark ? MARKS[c.mark] : null;
    return (isCur ? '<span style="color:#e8554e;font-weight:700">▶</span> ' : '') +
      (m ? pill(m.color, m.label) : '') +
      (live && c.note ? `<span title="${esc(c.note)}" style="margin-left:3px">📝</span>` : '') +
      (nb ? `<span style="margin-left:3px;color:#d98b00" title="${nb} 个书签">🔖${nb > 1 ? nb : ''}</span>` : '');
  }

  // 能点的进度小条。章节名可能很长，所以限宽 + 省略号 + 明确不换行
  const progPill = (bid, txt) =>
    `<span data-fw-jump="${esc(bid)}" title="点一下跳回读到的位置"` +
    ` style="background:#e8554e;color:#fff;padding:1px 6px;border-radius:8px;` +
    `margin-left:3px;display:inline-block;max-width:11em;overflow:hidden;` +
    `text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;cursor:pointer">` +
    `${esc(txt)}</span>`;

  /*
   * 书籍角标：自定义标签 + 读到哪 + 标了几章 + 有书评。
   * 正文页（compact）只留「第几章/共几章」—— 人就在书里读着，
   * 再把章节名和书签数挂到面包屑上是废话。
   */
  function bookBadgeHTML(b, compact) {
    if (!b || b.deleted) return '';
    const bp = DB.prog(b.id);
    if (compact) {
      if (!bp) return '';
      const no = bp.no, total = b.chapTotal;
      return progPill(b.id, no && total ? `${no}/${total}` : (no ? '第 ' + no + ' 章' : '已记下'));
    }
    const tags = (b.tags || []).map((t) => pill('#5a6b8c', esc(t))).join('');
    const prog = bp ? progPill(b.id, '▶ ' + (bp.title || '读过')) : '';
    const n = idx().markedCount(b.id);
    const cnt = n ? `<span style="color:#999;margin-left:4px">${n}章</span>` : '';
    const nb = idx().bmksOfBook(b.id).length;
    const bm = nb ? `<span style="color:#d98b00;margin-left:4px" title="${nb} 个书签">🔖${nb}</span>` : '';
    const rev = b.review ? '<span style="margin-left:3px" title="有书评">📝</span>' : '';
    return tags + prog + cnt + bm + rev;
  }

  /*
   * 正文页的面包屑：书名后面挂个「第几章/共几章」，说明进度确实记下来了。
   * 只在正文页做 —— 详情页和列表页挂的是完整角标（标签 + 读到某章 + 书签数）。
   */
  function paintChapterCrumb() {
    if (Page.type !== 'chapter' || !Page.bid) return;
    const html = bookBadgeHTML(DB.book(Page.bid, false), true);
    document.querySelectorAll(FW.SEL.bookCrumb(Page.bid))
      .forEach((el) => attachBadge(el, html));
  }

  // 最后一章末尾那个「✓ 我读完了」：进度补成 100%、标上已读完、回书籍主页。
  // 完结文翻到最后一章，进度多半停在 90% 上下，为了个百分比再滚一遍没意义
  function lastBtnHTML(ch) {
    const b = DB.book(Page.bid, false);
    if (!b || !b.chapTotal) return '';
    if (DB.chapNo(Page.bid, ch.pid) !== b.chapTotal) return '';   // 不是最后一章
    if (b.doneRead) return '<span style="margin-left:6px;color:#34a853;font-weight:700">✓ 已读完</span>';
    return `<span data-fw-done="${esc(Page.bid)}" style="display:inline-block;` +
      `margin-left:6px;padding:2px 11px;border-radius:11px;cursor:pointer;` +
      `background:#34a85322;color:#2c8c46;font-weight:700">✓ 我读完了</span>`;
  }

  /*
   * 从一份目录 DOM 里按顺序数出章节 id。
   *
   * **画角标和后台抓页面必须用同一份规则**，否则同一本书两条路数出来的总数不一样
   * （实测差 1：桌面版目录一行里有两个 /posts/ 链接，指的不是同一个 post，
   * 只有最后那个才是章节本身）。为此这个函数被两处共用：
   * paintCatalog（当前页面）和 cidsFromHtml（fetch 回来的页面）。
   */
  function collectCids(root) {
    const out = [];
    for (const w of root.querySelectorAll(FW.SEL.catalogWrap)) {
      for (const a of w.querySelectorAll(FW.SEL.catalogLink)) {
        const row = a.closest('tr');
        if (row) {
          const all = row.querySelectorAll(FW.SEL.catalogLink);
          if (all.length && all[all.length - 1] !== a) continue;
        }
        const m = /\/posts\/(\d+)/.exec(a.getAttribute('href') || '');
        if (m && !out.includes(m[1])) out.push(m[1]);
      }
    }
    return out;
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

    const prog = DB.prog(Page.bid);
    const seen = [];        // 按目录顺序去重后的章节 id
    for (const a of links) {
      // 桌面版目录一行里有两个链接指向同一章，只在最后那个上挂角标，免得画两遍
      const row = a.closest('tr');
      if (row) {
        const all = row.querySelectorAll(FW.SEL.catalogLink);
        if (all.length && all[all.length - 1] !== a) continue;
      }
      const cid = Page.native ? FW.pidOfLink(a) : Page.idsFrom(a.href).cid;
      if (!cid) continue;
      if (!seen.includes(cid)) seen.push(cid);
      learnChapName(cid, catalogNameOf(a, row));
      attachBadge(a, chapBadgeHTML(
        DB.chap(Page.bid, cid, false),
        !!(prog && prog.cid === cid),
        idx().bmksOfChap(Page.bid, cid).length));
    }
    learnBookMeta(seen, Page.type === 'catalog' && /\/profile/.test(location.pathname));
  }

  /*
   * 逛目录时顺手学下来的书籍元数据（正文页上算不出这些）：
   * cids 章节 id 的顺序（chapNo 靠它算「第几章」）、chapTotal 总数、done 完结状态。
   * 进度 tab 靠它们显示「第几章/共几章」、判断有没有新章、区分读完和在读。
   *
   * **权威来源是书籍详情页**（/profile）。目录列表页（/chapter_index）实测会比它
   * 少末尾几章，所以只在还没学过时才用它兜底 —— 不然两个页面来回覆盖，
   * 章节数会跳来跳去。
   */
  function learnBookMeta(cids, authoritative) {
    if (!Page.bid || !cids.length) return;
    const b = DB.book(Page.bid, false);
    if (!b) return;
    let dirty = false;

    if (authoritative || !(b.cids || []).length) {
      if (b.cids ? b.cids.join() !== cids.join() : true) { b.cids = cids; dirty = true; }
      if (b.chapTotal !== cids.length) { b.chapTotal = cids.length; dirty = true; }
      // 只精确到分钟：否则每次重绘都算「变了」，白触发一次保存和同步
      const seenAt = Math.floor(now() / 60000) * 60000;
      if (b.chapSeenAt !== seenAt) { b.chapSeenAt = seenAt; dirty = true; }
    }

    // 章节顺序变了，进度那一章的序号也跟着重算
    const pg0 = DB.prog(Page.bid);
    if (pg0) {
      const no = DB.chapNo(Page.bid, pg0.cid);
      if (no !== null && pg0.no !== no) { pg0.no = no; DB.touch(pg0); }
    }

    const done = bookDone();
    if (done !== null && b.done !== done) { b.done = done; dirty = true; }
    if (dirty) DB.touch(b);
  }

  /*
   * ---- 查新章 ----
   * 站点自己那个「有更新」标记不准，所以章节数只认自己数目录的结果：
   * 同源 fetch 那本书的目录页数一遍，用户不用一本本点开。
   *
   * **只在用户点的时候才跑**，不挂后台定时器 —— 什么时候该给站点发请求
   * 不该由脚本替用户决定。范围也收窄到「有进度、没标完结、还没读完」的书，
   * 一次最多 CHECK_MAX 本，被截掉的会在提示里说清楚。
   */
  const CHECK_MAX = 40;

  // 从一段目录页 HTML 里数出章节 id
  function cidsFromHtml(html) {
    // 撞上 WAF 挑战页就当没拿到 —— 硬解没意义
    if (/awsWafCookieDomainList/.test(html)) return [];
    return collectCids(new DOMParser().parseFromString(html, 'text/html'));
  }

  /*
   * 抓一本书的章节列表。
   * **以书籍详情页为准**（和逛目录时的规则一致）；万一那一页没嵌目录
   * （长书的主页只给一个「目录」链接），再退回目录列表页，总比什么都拿不到好。
   */
  async function fetchCids(bid) {
    for (const path of ['/profile', '/chapter_index']) {
      const r = await fetch(location.origin + '/threads/' + bid + path,
        { credentials: 'same-origin' });
      if (!r.ok) continue;
      const cids = cidsFromHtml(await r.text());
      if (cids.length) return cids;
    }
    return [];
  }

  async function checkOneBook(b) {
    const cids = await fetchCids(b.id);
    if (!cids.length) return false;

    // 只有「真有新东西」才动 updatedAt。光记一笔「查过了」就 touch 的话，
    // 点一下刷新，列表顺序全变 —— 用户抱怨过这个
    let hit = false;
    if ((b.cids || []).join() !== cids.join()) { b.cids = cids; hit = true; }
    if (b.chapTotal !== cids.length) { b.chapTotal = cids.length; hit = true; }
    if (hit) b.chapSeenAt = now();
    const pg = DB.prog(b.id);
    if (pg) {
      const no = DB.chapNo(b.id, pg.cid);
      if (no !== null && pg.no !== no) { pg.no = no; DB.touch(pg); }
    }
    return hit;
  }

  async function checkUpdates() {
    if (!Page.native) { toast('这一页查不了喵，在站内页面再点'); return 0; }

    const due = DB.liveBooks()
      .filter((b) => DB.prog(b.id) && b.done !== true && !DB.isFinished(b.id))
      .sort((a, c) => (a.chapCheckedAt || 0) - (c.chapCheckedAt || 0));
    const list = due.slice(0, CHECK_MAX);
    if (!list.length) { toast('没有在读的书要查喵'); return 0; }

    let changed = 0, i = 0;
    for (const b of list) {
      // 一本本报进度：书多的时候不然就是干等着，不知道卡没卡
      toast(`查新章 ${++i}/${list.length}…`, 0);
      let hit = false;
      try { hit = await checkOneBook(b); } catch (e) { /* 抓不到就跳过这本 */ }
      b.chapCheckedAt = now();
      // 没查出新东西就只 save、不 touch —— 别让「查过了」这一笔把排序搅乱
      if (hit) { changed++; DB.touch(b); } else { DB.save(); }
    }
    DB.d.lastCheck = now();
    await DB.saveNow();
    paintAll();
    // 被 CHECK_MAX 截掉的必须说出来，不然「查完了」会被当成「全查过了」
    const rest = due.length - list.length;
    const more = rest > 0 ? `（还有 ${rest} 本没查，再点一次接着查）` : '';
    toast(changed ? `有 ${changed} 本的章节数变了喵 ✓${more}`
                  : `${list.length} 本都查过了，没发现新章${more}`);
    return changed;
  }

  // 站点把「完结 / 连载」做成了书籍标签链接，title 属性拿得最稳。
  // 这一页没写就返回 null —— 别把已经学到的值覆盖掉
  function bookDone() {
    for (const a of document.querySelectorAll('a[href*="/tag/"]')) {
      const t = ((a.getAttribute('title') || a.textContent) || '').trim();
      if (t === '完结') return true;
      if (t === '连载') return false;
    }
    return null;
  }

  /*
   * 目录才是章节名的权威来源 —— 正文页标题区只有章节号（「2」）。
   * 所以逛目录时顺手学下来、回填给进度和书签，「上次读到」才不是个光秃秃的数字。
   * 桌面版目录是表格（第 1 格章节号、第 2 格章节名，都要）；手机版是一排按钮。
   */
  function catalogNameOf(a, row) {
    if (row) {
      const cells = [...row.querySelectorAll('th,td')].slice(0, 2)
        .map(cleanText).filter(Boolean);
      if (cells.length) return [...new Set(cells)].join(' ');
    }
    return cleanText(a);
  }

  // 只在「学到的名字更全」时才回填，避免把好名字覆盖成光数字，
  // 也避免每次逛目录都 touch 一遍、白白造同步流量
  function learnChapName(cid, name) {
    if (!name || !Page.bid) return;
    const richer = (a, b) => (a || '').length > (b || '').length;

    const c = DB.chap(Page.bid, cid, false);
    if (c && !c.deleted && richer(name, c.title)) { c.title = name; DB.touch(c); }

    const pg = DB.prog(Page.bid);
    if (pg && pg.cid === cid && richer(name, pg.title)) { pg.title = name; DB.touch(pg); }
    idx().bmksOfChap(Page.bid, cid).forEach((m) => {
      if (richer(name, m.title)) { m.title = name; DB.touch(m); }
    });
  }

  // ---- 书籍介绍页：书名后挂标签 + 目录上方一条「上次读到哪」 ----
  // 提示条和那排按钮挂哪。不能死绑目录容器 —— 长书的主页不嵌目录，
  // 只给一个「目录」链接，那样整块就不显示了。所以多级兜底，
  // 两处共用同一个宿主，顺序才好控制（提示条在上、按钮在下）
  function pageHost() {
    const wrap = document.querySelector(FW.SEL.catalogWrap);
    const panel = wrap && wrap.closest('.panel-body');
    if (panel) return panel;

    const crumbs = document.querySelectorAll(FW.SEL.bookCrumb(Page.bid));
    const crumb = crumbs[crumbs.length - 1];
    if (crumb && crumb.closest('div')) return crumb.closest('div');

    return document.querySelector('.panel-body') || null;
  }

  function paintProfile() {
    if (Page.type !== 'catalog' || !Page.bid) return;
    const b = DB.book(Page.bid, false);

    // 书名在这一页会出现两次（面包屑里和大标题里），两处都挂
    const badge = bookBadgeHTML(b);
    document.querySelectorAll(FW.SEL.bookCrumb(Page.bid))
      .forEach((el) => attachBadge(el, badge));

    const panel = pageHost();
    if (!panel) return;
    const p = DB.prog(Page.bid);
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
      strip.addEventListener('click', () => jumpTo(DB.prog(Page.bid)));
      panel.insertBefore(strip, panel.firstChild);
    }
    const html = `▶ 上次读到 <b>${esc(p.title || '某一章')}</b> · ${Math.round((p.cpct || p.pct || 0) * 100)}% —— 点这里继续`;
    if (strip.innerHTML !== html) strip.innerHTML = html;
  }

  /*
   * 书列表 / 收藏 / 首页 / 频道 / 搜索结果：书名后面挂角标。
   * 不靠条目的 class —— 这站每个页面的写法都不一样（item1id{n} / thread{n} /
   * threadid{n}…），认一处漏三处。改成认「书名链接」：指向 /threads/{n} 或
   * /threads/{n}/profile 的就挂，一招通吃。带 ?query 的是排序/筛选链接，跳过。
   */
  function paintBookList() {
    // 一本书只挂一份角标。收藏页里一个条目有两个链接指向同一本书
    // （书名 + 简介），不去重就会并排出现两个进度条
    const done = new Set();
    for (const a of document.querySelectorAll('a[href*="/threads/"]')) {
      const href = (a.getAttribute('href') || '').trim();   // 注意：站点有的 href 尾部带空格
      if (href.indexOf('?') >= 0) continue;
      const m = /\/threads\/(\d+)(?:\/profile)?$/.exec(href);
      if (!m || done.has(m[1])) continue;
      // 当前这本书的面包屑不在这儿管 —— 详情页交给 paintProfile、
      // 正文页交给 paintChapterCrumb（那边挂的是紧凑版）。
      // 不排掉的话同一个链接会被挂上两种角标，正文页上就并排出现两份
      if (m[1] === Page.bid && Page.type !== 'list') continue;
      const b = DB.book(m[1], false);
      if (!b || b.deleted) continue;
      done.add(m[1]);
      if (!attachListRows(a, b)) attachBadge(a, bookBadgeHTML(b));   // 找不到条目就退回挂书名后
    }
  }

  /*
   * 列表页（收藏 / 文库 / 频道 / 索引）的角标**自己占两行**，不塞进书名那一行 ——
   * 塞进去会把书名挤走、标题一长就折行，原来的排版全乱。
   *
   * 每种列表页的 class 名都不一样，但骨架是一致的：
   *   article > div.row > div.col-xs-*  （最后那个 col 是站点的「《最新章节》时间 + 标签」）
   * 所以插在**最后那一列之前**：我们的标签行成了倒数第三行、进度行倒数第二行，
   * 站点自己那行还留在最后。只有一列的页面（比如主题索引）没地方插，就追加到末尾。
   */
  function attachListRows(a, b) {
    const item = a.closest('article');
    if (!item) return false;
    const row = item.querySelector(':scope > .row') || item;

    let box = row.querySelector(':scope > [data-fw-rows]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-fw-rows', '1');
      box.style.cssText = 'width:100%;font-size:11px;line-height:1.9';
      const kids = [...row.children].filter((x) => !x.dataset.fwRows);
      if (kids.length >= 2) row.insertBefore(box, kids[kids.length - 1]);
      else row.appendChild(box);
    }

    const bp = DB.prog(b.id);
    const tags = (b.tags || []).map((t) => pill('#5a6b8c', esc(t))).join('');
    const n = idx().markedCount(b.id);
    const nb = idx().bmksOfBook(b.id).length;
    const extra =
      (n ? `<span style="color:#999;margin-left:4px">${n}章</span>` : '') +
      (nb ? `<span style="color:#d98b00;margin-left:4px" title="${nb} 个书签">🔖${nb}</span>` : '') +
      (b.review ? '<span style="margin-left:3px" title="有书评">📝</span>' : '');
    const line = (inner) => (inner ? `<div>${inner}</div>` : '');
    const html = line(tags + extra) +
      line(bp ? progPill(b.id, '▶ ' + (bp.title || '读过')) +
        (DB.isFinished(b.id) ? pill('#34a853', '✓ 读完') : '') : '');
    if (box.innerHTML !== html) box.innerHTML = html;
    return true;
  }

  // ---- 正文页：每章标题下面一条行内标记条 ----
  function paintInline() {
    if (Page.type !== 'chapter' || !Page.bid || !Page.chapters.length) return;
    const prog = DB.prog(Page.bid);
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
      // 备注已经不写了（章节内只留书签），但老数据里存量的还显示出来
      const note = live ? c.note : '';
      const btn = (extra, attrs, txt) =>
        `<span ${attrs} style="display:inline-block;margin:0 3px;padding:2px 11px;border-radius:11px;cursor:pointer;${extra}">${txt}</span>`;
      const nb = idx().bmksOfChap(Page.bid, ch.pid).length;
      const html =
        Object.entries(MARKS).map(([k, m]) =>
          btn(cur === k ? `background:${m.color};color:#fff;font-weight:700` : 'background:#8881;color:#999',
              `data-fw-mark="${k}" data-fw-pid="${ch.pid}"`, m.label)).join('') +
        // 只放一个图标：标了是亮的、没标是灰的，一眼就分得清，不用写字
        btn(nb ? 'background:#d98b0022;color:#d98b00;font-weight:700'
               : 'background:#8881;color:#bbb;filter:grayscale(1)',
            `data-fw-bmk="${ch.pid}"${nb ? ' data-fw-bmkon="1"' : ''}` +
            ` title="${nb ? '已加书签，点一下取消' : '给这一章加书签'}"`, '🔖') +
        (note ? `<span title="${esc(note)}" style="margin-left:6px;color:#8e8e93">📝 ${esc(note.slice(0, 16))}</span>` : '') +
        // 读到哪一章由面包屑上那个进度小条说明，这儿不用再写一遍
        // （原来挂个红字「▶ 读到这里」，反而让人猜不透是什么意思）
        lastBtnHTML(ch);
      if (bar.innerHTML !== html) bar.innerHTML = html;
    }
  }

  /*
   * ---- 面板入口 ----
   * 不用悬浮球：它会实打实压住页面内容（网站自己的按钮正好在那位置就点不到）。
   * 改成两个不挡路的入口 —— 挂进网站顶栏（全站可进）、书籍页目录上方一排按钮
   * （就近操作）。章节的标记和书签本来就是行内的，不需要进面板。
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
    const panel = pageHost();
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
    const nb = idx().bmksOfBook(Page.bid).length;
    const nc = idx().markedCount(Page.bid);
    const btn = (v, txt) =>
      `<span data-fw-open="${v}" style="display:inline-block;margin:0 4px;padding:3px 12px;` +
      `border-radius:12px;cursor:pointer;background:#8881;color:#666">${txt}</span>`;
    const html =
      btn('book', `📖 标签 / 书评 / 书签${nb ? ' 🔖' + nb : ''}`) +
      btn('all', `📚 我的标记${nc ? ' · 本书 ' + nc + ' 章' : ''}`) +
      btn('cfg', '⚙️');
    if (bar.innerHTML !== html) bar.innerHTML = html;
  }

  function paintAll() {
    IDX = null;                       // 这一轮重新建索引，免得读到过期数据
    injectNavEntry(); injectPageActions();
    paintCatalog(); paintProfile(); paintBookList(); paintInline(); paintChapterCrumb();
  }
  paintAll();

  // 行内标记条的点击：打标签 / 加书签；以及各处入口、书名后的进度条
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element
      ? e.target.closest('[data-fw-mark],[data-fw-bmk],[data-fw-open],[data-fw-jump],' +
        '[data-fw-done]') : null;
    if (!t) return;
    e.preventDefault(); e.stopPropagation();

    // 顶栏那一项 / 书籍页那排按钮
    if (t.hasAttribute('data-fw-open')) {
      openView(t.getAttribute('data-fw-open') || 'all');
      return;
    }

    // 「▶ 读到某章」那条嵌在网站的书名 <a> 里面，所以上面那句 preventDefault
    // 很关键 —— 不拦就顺着链接去书籍主页了，而不是跳到读到的那一章
    if (t.hasAttribute('data-fw-jump')) {
      const p = DB.prog(t.getAttribute('data-fw-jump'));
      if (p) jumpTo(p); else toast('这本还没有进度喵');
      return;
    }

    /*
     * 最后一章末尾的「✓ 我读完了」：进度补成 100%、标上已读完，然后回书籍主页。
     * 补 100% 是故意的 —— 说读完了就别让进度还停在 93% 上刺眼。
     */
    if (t.hasAttribute('data-fw-done')) {
      const bid = t.getAttribute('data-fw-done');
      const p = DB.prog(bid);
      if (p) { p.cpct = 1; p.pct = 1; DB.touch(p); }
      DB.setDoneRead(bid, true);
      toast('读完啦，标上了喵 ✓');
      DB.saveNow().then(() => { location.href = DB.bookUrl(bid); });
      return;
    }

    const pid = t.getAttribute('data-fw-pid') || t.getAttribute('data-fw-bmk');
    if (!Page.bid || !pid) return;
    const ch = Page.chapters.find((x) => x.pid === pid);

    if (t.hasAttribute('data-fw-bmk')) {
      toggleBmk(pid);
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
    /*
     * 分页 / 懒加载 / 网站自己改 DOM 时补画。
     * 只认**网站自己**的改动 —— 我们插进去的角标（data-fw-*）也会触发观察器，
     * 不过滤的话就是「画一次 → 被自己惊动 → 再画一次」，白烧一轮。
     */
    const isOurs = (n) => n.nodeType === 1 && (n.id === '__fw_marks__' || (n.dataset &&
      (n.dataset.fwBadge || n.dataset.fwBar || n.dataset.fwRows ||
       n.dataset.fwStrip || n.dataset.fwActions || n.dataset.fwNav)));
    const inOurs = (n) => {
      for (let e = n; e; e = e.parentElement) if (isOurs(e)) return true;
      return false;
    };
    // 这一条改动是我们自己弄出来的？（改在角标内部，或者加/删的全是角标本身）
    const mine = (r) => {
      if (inOurs(r.target)) return true;
      const ns = [...r.addedNodes, ...r.removedNodes];
      return ns.length > 0 && ns.every(isOurs);
    };
    new MutationObserver((recs) => {
      if (!recs.some((r) => !mine(r))) return;
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
  /*
   * 离开页面前保底记一次。pagehide 之后 GM 的异步写入基本是丢的 ——
   * 真正救命的是 GMx.set 里那步同步 localStorage 镜像。
   * visibilitychange 比 pagehide 早也更可靠（切标签、切后台、锁屏都触发），
   * 所以两个都挂上。
   */
  function flush() {
    if (Page.type === 'chapter') Progress.record();
    DB.saveNow();
  }
  addEventListener('pagehide', flush);

  /*
   * ---- 回到这个页面时，把别处记的东西拉进来 ----
   * 数据不会被冲掉（写那一侧由 DB._flush 的逐条合并兜着），这里管的是**显示**
   * 要跟上：Safari 的「返回」是页面缓存，恢复出来的老页面连内存里那份 DB.d
   * 都是当初加载时的。三个时机各覆盖一种情况 ——
   *   pageshow(persisted)  从页面缓存恢复（Safari 的返回）
   *   visibilitychange     切回这个标签页 / 解锁屏幕
   *   storage              另一个标签页刚写过（同源 localStorage 会广播）
   */
  function pullStore() {
    if (!DB.mergeStored(DB.stored(true))) return;
    paintAll();
    // 正在输入的时候不重绘面板，否则光标和输入法全丢
    const ae = R.activeElement;
    const typing = ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName);
    if (!typing && sheet.classList.contains('on')) render();
  }
  addEventListener('pageshow', (e) => { if (e.persisted) pullStore(); });
  addEventListener('storage', (e) => { if (e.key === '__fwm__db') pullStore(); });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else pullStore();
  });
})();
