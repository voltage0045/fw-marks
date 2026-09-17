#!/usr/bin/env python3
"""
Mac 本地测试台 —— 不用装扩展、不用连网、不碰真站，就能验脚本。

原理：
  1. 起个本地小服务，把 test/pages/ 里的「真实页面夹具」按线上真实路径伺服
     （URL 模式匹配，所以随便点 id 都能开），这样脚本里靠 location.pathname
     判页面类型的逻辑才会走到正确分支
  2. 往页面里依次注入：种子数据 → fw-marks.user.js → 断言脚本
     脚本检测不到 GM API 会自动降级用 localStorage，所以裸浏览器里也能跑
  3. 用 headless Chrome 打开，把断言结果 dump 出来比对

跑法：  python3 test/run-test.py
       python3 test/run-test.py --serve     只起服务，自己用浏览器点着逛
                                            首页 http://127.0.0.1:8899/
                                            路由表 http://127.0.0.1:8899/__routes__
"""

import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, 'fw-marks.user.js')
PAGES = os.path.join(HERE, 'pages')

# 端口可以换：--port 8898，或者 FW_PORT=8898。
# 不然一边开着 --serve 逛、一边想跑测试就会撞端口
PORT = int(os.environ.get('FW_PORT', '8899'))
for _i, _a in enumerate(sys.argv):
    if _a == '--port' and _i + 1 < len(sys.argv):
        PORT = int(sys.argv[_i + 1])

TID = '279864'          # 有夹具的那本书
BOGUS_TID = '280269'    # 用来验 v1.0 假数据迁移
# thread.html 里那 6 章（按出现顺序）
PIDS = ['15749637', '15771234', '15776844', '15781781', '15787165', '15794090']
PID_PROGRESS = PIDS[0]  # 进度指向第一章 —— post.html 夹具正好是这一章，跳转落地能验
PID_CLICK = PIDS[2]     # 拿来做「点 🔖」交互测试的那一章（种子里没标记也没书签）

# 自己的用户 id。只用来拼「收藏 / 个人中心」这两个测试地址。
# 默认给个占位值 —— 真实账号 id 不进公共仓库。要用真号跑：FW_UID=xxxxx python3 ...
UID = os.environ.get('FW_UID', '100000')

# 各列表页里真实存在的书 id（各页夹具抓的是不同批书，互不重叠，所以得一页一个）。
# 种子里给它们都打上标签，才能验「书名后面挂标签」在每个页面都生效。
LIST_TIDS = {
    'collection':   '290082',
    'home':         '4822',
    'channel':      '114434',
    'thread_index': '85483',
}

# URL 模式 → 夹具。用模式而不是固定路径，这样点任何 id 都能开，不会到处 404
PATTERNS = [
    (r'^/$',                          'home.html'),
    (r'^/threads/\d+/profile$',       'profile.html'),
    (r'^/threads/\d+/chapter_index$', 'chapter_index.html'),
    (r'^/threads/\d+$',               'thread.html'),
    (r'^/posts/\d+$',                 'post.html'),
    (r'^/books$',                     'books.html'),
    (r'^/thread_index$',              'thread_index.html'),
    (r'^/collection/\d+$',            'collection.html'),
    (r'^/status_collection$',         'status.html'),
    (r'^/users/\d+/usercenter$',      'usercenter.html'),
    (r'^/channels/\d+$',              'channel.html'),
    (r'^/tag$',                       'tag.html'),
    (r'^/tag/\d+$',                   'tag_list.html'),
    (r'^/quote/\d+$',                 'quote.html'),
]

NICE = {
    'home.html': '首页', 'profile.html': '书籍介绍 + 目录',
    'chapter_index.html': '纯目录列表', 'thread.html': '正文（一页多章）',
    'post.html': '单章固定链接', 'books.html': '文库', 'thread_index.html': '主题索引',
    'collection.html': '收藏', 'status.html': '动态', 'usercenter.html': '个人中心',
    'channel.html': '频道', 'tag.html': '标签云', 'tag_list.html': '某标签下的书',
    'quote.html': '打赏/引用',
}

SAMPLE_URLS = [
    ('/', '首页'),
    (f'/collection/{UID}', '收藏'),
    (f'/books', '文库'),
    (f'/threads/{TID}/profile', '书籍介绍 + 目录'),
    (f'/threads/{TID}/chapter_index', '纯目录列表'),
    (f'/threads/{TID}', '正文（一页多章）'),
    (f'/posts/{PID_PROGRESS}', '单章固定链接'),
    ('/thread_index', '主题索引'),
    ('/channels/1', '频道'),
    ('/status_collection', '动态'),
    (f'/users/{UID}/usercenter', '个人中心'),
    ('/tag', '标签云'),
]


def route_for(path):
    for pat, fixture in PATTERNS:
        if re.match(pat, path):
            p = os.path.join(PAGES, fixture)
            if os.path.exists(p):
                return p
    return None


# ---- 种子数据：假装用户已经标过一些东西 ----
SEED = {
    'v': 1,
    'books': {
        TID: {
            'id': TID, 'title': '测试书', 'url': f'/threads/{TID}/profile',
            'tags': ['追更中', '甜文'], 'review': '总评测试', 'updatedAt': 1,
        },
        BOGUS_TID: {
            'id': BOGUS_TID, 'title': '旧版假数据', 'url': '', 'tags': [], 'review': '',
            'updatedAt': 1,
        },
    },
    # 阅读进度：v1.5 起是独立一张表，不再塞在书记录里
    'prog': {
        TID: {
            'bid': TID, 'cid': PID_PROGRESS, 'title': '第一章',
            'url': f'/posts/{PID_PROGRESS}',
            # updatedAt 特意给大，用来验「最近读的排最前」
            'pct': 0.4, 'cpct': 0.55, 'anchor': '', 'ts': 1, 'updatedAt': 5000,
        },
    },
    'chaps': {
        f'{TID}|{PIDS[0]}': {'bid': TID, 'cid': PIDS[0], 'title': '第一章',
                             'mark': 'good', 'note': '', 'url': '', 'updatedAt': 1},
        f'{TID}|{PIDS[1]}': {'bid': TID, 'cid': PIDS[1], 'title': '第二章',
                             'mark': 'skip', 'note': '这里有个伏笔', 'url': '', 'updatedAt': 1},
        # 同样是 v1.0 的假章节：cid == bid
        f'{BOGUS_TID}|{BOGUS_TID}': {'bid': BOGUS_TID, 'cid': BOGUS_TID, 'title': '',
                                     'mark': 'good', 'note': '', 'url': '', 'updatedAt': 1},
    },
    # 两个手动书签，都不带名字（书签就是个位置，不需要命名）
    'bmks': {
        f'{TID}|{PIDS[1]}-1': {
            'key': f'{TID}|{PIDS[1]}-1', 'bid': TID, 'cid': PIDS[1], 'title': '第二章',
            'url': f'/posts/{PIDS[1]}', 'pct': 0.4, 'cpct': 0.6, 'anchor': '',
            'createdAt': 2, 'updatedAt': 2,
        },
        f'{TID}|{PIDS[3]}-2': {
            'key': f'{TID}|{PIDS[3]}-2', 'bid': TID, 'cid': PIDS[3], 'title': '第四章',
            'url': f'/posts/{PIDS[3]}', 'pct': 0.7, 'cpct': 0.2, 'anchor': '',
            'createdAt': 1, 'updatedAt': 1,
        },
    },
    'tagPool': ['追更中', '甜文', '弃坑', '列表验证'],
    'site': {},
    'cfg': {'token': '', 'repo': '', 'davUrl': '', 'davUser': '', 'davPass': '', 'autoSync': False},
    'lastSync': 9999999999999,
    'status': {},
    # 默认就标成「已迁移」，否则测试台每开一页都重灌一次种子、
    # 迁移就又跑一遍，提示会没完没了地弹。
    # 想验迁移的用例走 ?fwtest=legacy，那时才把这些标记去掉
    'mig1': True,
    'mig2': True,
    'mig3': True,
}

# 各列表页的样本书也塞进种子，统一打「列表验证」标签
for _page, _tid in LIST_TIDS.items():
    SEED['books'][_tid] = {
        'id': _tid, 'title': f'列表样本-{_page}', 'url': '',
        'tags': ['列表验证'], 'review': '', 'updatedAt': 1,
    }

# ---- 断言：在页面里跑，结果写进 #FWTEST ----
# 除了看渲染结果，还会真的 click() 一下，验证书签能不能写进存储 —— 静态检查
# 只能证明「画对了」，点得动才证明「能用」
CHECK_JS = r"""
(function () {
  var errs = [];
  window.addEventListener('error', function (e) { errs.push(String(e.message)); });
  function txt(sel) {
    return [].map.call(document.querySelectorAll(sel), function (e) { return e.textContent; }).join(' | ');
  }
  function n(sel) { return document.querySelectorAll(sel).length; }
  function db() {
    try { return JSON.parse(localStorage.getItem('__fwm__db')) || {}; } catch (e) { return {}; }
  }
  function liveBmks() {
    var m = db().bmks || {}, out = [];
    for (var k in m) if (!m[k].deleted) out.push(m[k]);
    return out;
  }
  function barOf(pid) {
    var el = document.querySelector('[data-fw-bar="' + pid + '"]');
    return el ? el.textContent : '';
  }

  var r = {};
  setTimeout(function () {
    var d = db();
    var bogus = (d.books || {})['__BOGUS__'] || null;
    var bogusChap = (d.chaps || {})['__BOGUS__|__BOGUS__'] || null;
    var real = (d.books || {})['__TID__'] || null;

    r = {
      page: location.pathname,
      scrollY: Math.round(window.scrollY),
      jsErrors: errs,
      injected: n('#__fw_marks__'),
      navEntry: n('[data-fw-nav] [data-fw-open]'),
      navText: txt('[data-fw-nav]'),
      pageActions: n('[data-fw-actions] [data-fw-open]'),
      // 悬浮球必须彻底没有了（它会压住网站自己的按钮）
      fabLeft: (function () {
        var h = document.getElementById('__fw_marks__');
        return h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.fab').length : -1;
      })(),
      badges: n('[data-fw-badge]'),
      badgeText: txt('[data-fw-badge]').slice(0, 900),
      strips: n('[data-fw-strip]'),
      stripText: txt('[data-fw-strip]').slice(0, 200),
      bars: n('[data-fw-bar]'),
      barsText: txt('[data-fw-bar]').slice(0, 700),
      crumbBadge: n('a[href$="/threads/__TID__/profile"] [data-fw-badge]'),
      bookItemBadge: n('article[class*="item"][class*="id__TID__"] [data-fw-badge]'),
      markBtns: n('[data-fw-mark]'),
      bmkBtns: n('[data-fw-bmk]'),
      bmkSeeded: liveBmks().length,
      // 同一章里还活着的书签（验跨设备去重）
      dupLive: liveBmks().filter(function (m) { return m.cid === '__PID_BMK__'; }).length,
      dupSurvivor: (liveBmks().filter(function (m) { return m.cid === '__PID_BMK__'; })[0] || {}).key || '',
      barMarked: barOf('__PID_BMK__'),
      barPlain: barOf('__PID_CLICK__'),
      renameBtns: n('[data-bmkname]'),
      // v1.0 假数据迁移
      migFlag: d.mig1 === true && d.mig2 === true,
      migProgressCleared: bogus ? !bogus.progress : null,
      migBookDeleted: bogus ? !!bogus.deleted : null,
      migChapDeleted: bogusChap ? !!bogusChap.deleted : null,
      migRealKept: real ? !real.deleted : null,
      // v1.5：进度搬进独立的 prog 表，书记录里那个字段要消失
      progTable: (d.prog || {})['__TID__'] || null,
      progLeftInBook: real ? !!real.progress : null,
      progBogusMoved: !!(d.prog || {})['__BOGUS__'],

      // 悬浮球有没有把页面上的链接盖住 —— 盖住了的话真站上也会「点不了」。
      // elementFromPoint 是唯一靠谱的判法：光看 CSS 说 display:none 不算数。
      blockedLinks: (function () {
        var bad = [], as = document.querySelectorAll('a[href]');
        for (var i = 0; i < as.length && bad.length < 4; i++) {
          var a = as[i], rc = a.getBoundingClientRect();
          if (rc.width < 4 || rc.height < 4) continue;
          if (rc.top < 0 || rc.bottom > innerHeight || rc.left < 0 || rc.right > innerWidth) continue;
          var cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
          var el = document.elementFromPoint(cx, cy);
          var ok = el && (el === a || a.contains(el) || el.contains(a));
          if (!ok) {
            // 穿进 shadow 里看究竟是哪个部件压着，不然只会看到宿主 div
            var inner = '';
            var hostEl = document.getElementById('__fw_marks__');
            if (hostEl && hostEl.shadowRoot && hostEl.shadowRoot.elementFromPoint) {
              var ie = hostEl.shadowRoot.elementFromPoint(cx, cy);
              if (ie) inner = ie.tagName + '.' + (ie.className || '');
            }
            bad.push((a.getAttribute('href') || '') +
              ' @(' + Math.round(cx) + ',' + Math.round(cy) + ')' +
              ' 被 ' + (el ? el.tagName + '#' + (el.id || '') : 'null') +
              (inner ? ' > ' + inner : '') + ' 挡住');
          }
        }
        return bad;
      })(),

      // 子 tab 这类链接，点击事件到不到得了它身上
      tabReachable: (function () {
        var t = document.querySelector('.nav-tabs a[href*="group="]') ||
                document.querySelector('.nav-tabs a[href]');
        if (!t) return null;
        var got = false;
        var h = function (e) { got = true; e.preventDefault(); e.stopPropagation(); };
        t.addEventListener('click', h, true);
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        t.removeEventListener('click', h, true);
        return got;
      })(),
    };

    // 点顶栏那一项，面板得真的打开（没了悬浮球，这就是唯一的全站入口）
    (function () {
      var a = document.querySelector('[data-fw-nav] [data-fw-open]');
      if (!a) { r.navOpens = null; return; }
      a.click();
      var h = document.getElementById('__fw_marks__');
      var sr = h && h.shadowRoot;
      var sh = sr ? sr.querySelector('.sheet') : null;
      r.navOpens = !!(sh && sh.classList.contains('on'));
      // 三个 subtab 都该存在
      r.tabCount = sr ? sr.querySelectorAll('.tabs [data-tab]').length : 0;
      // 排序验在「评价」tab：默认的「书签」tab 只有一本书有书签，看不出先后。
      // 取书 id 而不是书名 —— 书名会被页面上的真实标题覆盖（noteBook 会更新它）
      var rate = sr ? sr.querySelector('[data-tab="rate"]') : null;
      if (rate) rate.click();
      r.allListOrder = sr
        ? [].map.call(sr.querySelectorAll('.book'),
            function (e) { return e.getAttribute('data-bid'); }).slice(0, 3)
        : [];
      var cls = h && h.shadowRoot ? h.shadowRoot.querySelector('.cls') : null;
      if (cls) cls.click();   // 关回去，别影响后面的断言
    })();

    /* 模式一：点「上次读到」提示条。
     *
     * 麻烦在于点了就会跳转，文档一被换走，dump-dom 就什么都取不到。
     * 办法：
     *   1. 临时钩住 Storage.setItem，截下脚本存的「定位接力棒」
     *   2. 把结果写进 localStorage
     *   3. 同一个同步任务里再把 location.href 改指到 /__relay__ —— 后一次赋值
     *      会盖掉脚本刚发起的那次跳转，于是落地在取结果页上，结果就带出来了
     */
    if (location.search.indexOf('fwtest=strip') >= 0) {
      var s = document.querySelector('[data-fw-strip]');
      if (s) {
        var cap = null, origSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (k === '__fw_jump__') cap = v;
          return origSet.apply(this, arguments);
        };
        s.click();
        Storage.prototype.setItem = origSet;
        r.jumpPending = cap || '';
        r.jsErrors = errs;
        try { localStorage.setItem('__fw_relay__', JSON.stringify(r)); } catch (e) {}
        location.href = '/__relay__';
        return;
      }
    }

    /* 模式三：滚到别的一章，看进度有没有及时换过去并落盘。
     * 「读到一半关掉、进度没更新」就是这条路上出的问题：
     * 防抖挂太久 + GM 存储是异步的，关页面那一刻两头都还没落地 */
    if (location.search.indexOf('fwtest=scroll') >= 0) {
      var bar = document.querySelector('[data-fw-bar="__PID_CLICK__"]');
      var blk = bar ? bar.closest('[id^="post"]') : null;
      if (!blk) { r.scrollTested = false; return finish(); }
      blk.scrollIntoView();
      window.scrollBy(0, 40);
      setTimeout(function () {
        var d2 = db();
        var bk = (d2.books || {})['__TID__'] || {};
        r.scrollTested = true;
        var pg = (d2.prog || {})['__TID__'];
        r.progAfterScroll = pg ? pg.cid : null;
        r.progHasPos = !!(pg && typeof pg.cpct === 'number');
        r.savedAt = d2.savedAt || 0;
        finish();
      }, 900);
      return;
    }

    // 模式二：点没书签那一章的 🔖，看能不能加上、再点能不能取消
    var btn = document.querySelector('[data-fw-bmk="__PID_CLICK__"]');
    if (!btn) { r.clickTested = false; return finish(); }
    r.clickTested = true;
    btn.click();
    setTimeout(function () {
      r.bmkAfterAdd = liveBmks().length;
      r.barAfterAdd = barOf('__PID_CLICK__');
      document.querySelector('[data-fw-bmk="__PID_CLICK__"]').click();
      setTimeout(function () {
        r.bmkAfterToggle = liveBmks().length;
        finish();
      }, 400);
    }, 400);
  }, 1500);

  function finish() {
    r.jsErrors = errs;
    var d = document.createElement('div');
    d.id = 'FWTEST';
    d.textContent = JSON.stringify(r);
    document.body.appendChild(d);
  }
})();
""".replace('__TID__', TID).replace('__BOGUS__', BOGUS_TID) \
   .replace('__PID_BMK__', PIDS[1]).replace('__PID_CLICK__', PID_CLICK)


# ?fwtest=landing 时预先塞进 sessionStorage 的「定位接力棒」，
# 用来验证从书签/继续读跳过来之后，落地页会不会自动复位
JUMP_POS = {
    'bid': TID, 'cid': PID_PROGRESS, 'title': '第一章',
    'url': f'/posts/{PID_PROGRESS}', 'pct': 0.4, 'cpct': 0.55, 'anchor': '', 'ts': 1,
}


def inject_html(html, query=''):
    # 全程用拼接，不用 % 格式化 —— 注入的内容里要是带个 % 就会被当成格式符炸掉
    data = SEED
    if 'fwtest=dupbmk' in query:
        # 模拟两台设备各自在「同一个位置」加过书签：key 不同、章内位置只差 2%。
        # 去重应该只留一条，而且留的必须是 createdAt 更早的那条（确定性）
        data = json.loads(json.dumps(SEED))
        data.pop('mig3', None)
        base = dict(SEED['bmks'][f'{TID}|{PIDS[1]}-1'])
        later = dict(base)
        later.update({'key': f'{TID}|{PIDS[1]}-999', 'cpct': 0.62,
                      'createdAt': 9999, 'updatedAt': 9999})
        data['bmks'][f'{TID}|{PIDS[1]}-999'] = later

    elif 'fwtest=deleted' in query:
        # 书被「我的标记」里删掉之后，书籍详情页不该还显示「上次读到」。
        # 注意只删书、不动 prog —— 要验的正是「书没了，进度就不该再显示」
        data = json.loads(json.dumps(SEED))
        data['books'][TID]['deleted'] = True

    elif 'fwtest=legacy' in query:
        # 深拷贝后退回 v1.4 的老结构：进度塞在书记录里、prog 表空着，
        # 再把迁移标记去掉 —— 这样 mig1（清假数据）和 mig2（进度搬家）都会真跑
        data = json.loads(json.dumps(SEED))
        data.pop('mig1', None)
        data.pop('mig2', None)
        data['books'][TID]['progress'] = dict(SEED['prog'][TID])
        data['books'][BOGUS_TID]['progress'] = {
            'cid': BOGUS_TID, 'title': '', 'url': f'/threads/{BOGUS_TID}/profile',
            'pct': 0.5, 'anchor': '', 'ts': 1,
        }
        data['prog'] = {}
    seed = json.dumps(json.dumps(data))
    parts = ['<script>try{localStorage.setItem("__fwm__db", ' + seed + ')}catch(e){}</script>']
    if 'fwtest=landing' in query:
        parts.append('<script>try{sessionStorage.setItem("__fw_jump__", '
                     + json.dumps(json.dumps(JUMP_POS)) + ')}catch(e){}</script>')
    parts.append('<script src="/fw-marks.user.js"></script>')
    parts.append('<script>' + CHECK_JS + '</script>')
    inject = ''.join(parts)
    # 夹具里的绝对域名要改回本地，否则点链接会跑到真站上去
    html = re.sub(r'https?://www\.xn--pxtr7m5ny\.com', '', html)
    return html.replace('</body>', inject + '</body>') if '</body>' in html else html + inject


def routes_page(path, found):
    """没夹具的页面给张说明页，别甩 404 —— 主要是方便 --serve 手动点着逛。"""
    rows = ''.join(
        f'<li><a href="{u}">{u}</a> &nbsp;<span style="color:#888">{d}</span></li>'
        for u, d in SAMPLE_URLS)
    head = ('<h2>本地测试台</h2>' if found else
            f'<h2>这个页面没抓夹具喵</h2><p style="color:#c00">'
            f'<code>{path}</code> 不在夹具清单里 —— 本地测试台只有下面这些页面。<br>'
            f'想加的话：抓一份真页面存到 <code>test/pages/</code>，再往 '
            f'<code>PATTERNS</code> 里加一行。</p>')
    return ('<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>本地测试台</title><style>'
            'body{font:15px/1.9 -apple-system,sans-serif;max-width:640px;margin:36px auto;padding:0 18px}'
            'li{margin:3px 0}code{background:#f0f0f2;padding:1px 5px;border-radius:4px}'
            '</style></head><body>' + head +
            '<h3>可以点的页面</h3><ul>' + rows + '</ul>'
            '<p style="color:#888;font-size:13px">夹具的正文都换成了占位文本，只保留 DOM 骨架。<br>'
            '样式表指向站点 CDN，本地没代理的话会加载不出来 —— 页面会很朴素，但功能照跑。</p>'
            '</body></html>')


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype='text/html; charset=utf-8', code=200):
        b = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        # 不留 keep-alive：浏览器攥着空闲连接不放会把服务卡死
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        bits = self.path.split('?', 1)
        path, query = bits[0], (bits[1] if len(bits) > 1 else '')
        if len(path) > 1:
            path = path.rstrip('/') or '/'

        if path == '/fw-marks.user.js':
            with open(SCRIPT, encoding='utf-8') as f:
                return self._send(f.read(), 'application/javascript; charset=utf-8')

        if path == '/__routes__':
            return self._send(routes_page(path, True))

        # 取结果页：故意不注入脚本，只把上一页存下的断言结果吐到 DOM 里
        if path == '/__relay__':
            return self._send(
                '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
                '<script>'
                'var v=null;try{v=localStorage.getItem("__fw_relay__");'
                'localStorage.removeItem("__fw_relay__")}catch(e){}'
                'var d=document.createElement("div");d.id="FWTEST";'
                'd.textContent=v||"{}";document.body.appendChild(d);'
                '</script></body></html>')

        fixture = route_for(path)
        if not fixture:
            return self._send(inject_html(routes_page(path, False), query))

        with open(fixture, encoding='utf-8') as f:
            return self._send(inject_html(f.read(), query))


def serve():
    # 必须是多线程：Chrome 会同时开好几条连接（页面 + 那个 .js），
    # 单线程 TCPServer 会一边等第一条连接、一边饿死第二条，直接死锁
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def dump(url):
    """跑一次 headless Chrome 取回渲染后的 DOM。

    注意：不能用 subprocess.run 等它退出 —— Chrome 的自动更新子进程会一直赖着，
    主进程 DOM 早就 dump 完了也不结束。所以这里盯输出文件，
    一看到断言结果就收工杀进程。
    """
    import shutil
    import tempfile
    import time
    tmp = tempfile.NamedTemporaryFile(suffix='.html', delete=False)
    tmp.close()
    # 每次都用独立的 profile 目录。共用一个的话，上一个 Chrome 还没退干净时，
    # 新启的这个会「挂到那个实例上开个标签页」，--dump-dom 就一个字都不输出，
    # 表现为单独跑能过、连着跑就挂
    profile = tempfile.mkdtemp(prefix='fw-test-profile-')
    with open(tmp.name, 'w') as fo, open(os.devnull, 'w') as fe:
        p = subprocess.Popen(
            # 用 old headless：新版 headless 是个真 app 进程，会在 Dock 里注册图标
            # 一直跳；旧版是纯后台进程，抓 DOM 的能力完全一样
            [CHROME, '--headless=old', '--disable-gpu', '--no-sandbox',
             '--no-first-run', '--no-default-browser-check', '--disable-extensions',
             '--disable-component-update', '--user-data-dir=' + profile,
             '--virtual-time-budget=12000', '--dump-dom', url],
            stdout=fo, stderr=fe)
        out = ''
        gone = 0
        for _ in range(140):          # 最多等 70 秒
            time.sleep(0.5)
            with open(tmp.name, encoding='utf-8', errors='replace') as f:
                out = f.read()
            if 'id="FWTEST"' in out:
                break
            if p.poll() is not None:
                # 进程没了：再多等两轮让缓冲落盘，别干等 70 秒
                gone += 1
                if out or gone > 3:
                    break
        p.kill()
    os.unlink(tmp.name)
    shutil.rmtree(profile, ignore_errors=True)
    m = re.search(r'<div id="FWTEST">(.*?)</div>', out, re.S)
    if not m:
        return None, out
    return json.loads(m.group(1).replace('&quot;', '"').replace('&amp;', '&')), out


def static_checks():
    """不开浏览器的源码级检查。

    主要防一类事故：以后往 snapshot() 里加字段时，把 token / 应用密码
    一起传上云。snapshot() 是白名单式的（显式列要传的字段），
    这里就盯着它别被改成会带 cfg 的样子。
    """
    s = open(SCRIPT, encoding='utf-8').read()
    checks = []

    def body_of(pattern):
        m = re.search(pattern, s, re.S)
        return m.group(0) if m else ''

    # 扫之前先把注释去掉 —— 注释里提一句「cfg / token」不算泄漏，
    # 但会让检查误报（之前就踩过）
    def code_only(x):
        return re.sub(r'//.*', '', x)

    snap = code_only(body_of(r'snapshot\(\)\s*\{.*?\n    \},'))
    apply_ = code_only(body_of(r'apply\(remote\)\s*\{.*?\n    \},'))
    secrets = ('cfg', 'token', 'davPass', 'davUser')

    checks.append(('snapshot() 存在（能被解析到）', bool(snap)))
    checks.append(('上传的快照里不含任何凭据字段',
                   bool(snap) and not any(k in snap for k in secrets)))
    checks.append(('apply() 不会用云端数据覆盖本地凭据',
                   bool(apply_) and 'cfg' not in apply_))
    checks.append(('凭据默认值都是空字符串',
                   bool(re.search(r"token: '', repo: ''", s)) and
                   bool(re.search(r"davUser: '', davPass: ''", s))))
    checks.append(('@connect 没有通配符（联网范围是白名单）',
                   not re.search(r'^// @connect\s+\*\s*$', s, re.M)))
    checks.append(('已经不再用 secret gist 存数据',
                   'gistId' not in s and 'data-gist' not in s))
    # 同步哪些表由 COLLECTIONS 一处决定，所以直接盯住它别混进凭据
    m = re.search(r"const COLLECTIONS = \[(.*?)\]", s)
    coll = [x.strip().strip("'\"") for x in (m.group(1).split(',') if m else [])]
    # 开关必须真的卡住 ready()，否则「关掉」只是界面上看着关了、照样在同步
    checks.append(('云端开关真的控制 ready()',
                   bool(re.search(r"ready: \(\) => !!\(DB\.d\.cfg\.repoOn", s)) and
                   bool(re.search(r"ready: \(\) => !!\(DB\.d\.cfg\.davOn", s))))
    checks.append(('设置里两段都有开关',
                   s.count('data-backon=') >= 2))
    checks.append(('同步的表清单是白名单，且不含 cfg',
                   bool(coll) and 'cfg' not in coll and
                   set(coll) == {'books', 'chaps', 'bmks', 'prog'}))

    print('=== 静态检查（源码级，不开浏览器）===')
    ok = 0
    for name, good in checks:
        print(f'  {"✅" if good else "❌"} {name}')
        ok += bool(good)
    return ok, len(checks), [n for n, g in checks if not g]


def main():
    srv = serve()
    if '--serve' in sys.argv:
        print(f'服务已起。浏览器打开： http://127.0.0.1:{PORT}/')
        print(f'路由表：            http://127.0.0.1:{PORT}/__routes__')
        print('（Ctrl-C 结束）')
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            return

    if not os.path.exists(CHROME):
        print('× 没找到 Chrome。可以改用 python3 test/run-test.py --serve 手动在浏览器里看')
        return 1

    cases = [
        (f'/threads/{TID}/profile', '书籍介绍 + 目录页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('目录角标画出来了',       lambda r: r['badges'] >= 3),
            ('角标里有章节标签',       lambda r: '精彩' in r['badgeText'] and '跳过' in r['badgeText']),
            ('书名后挂了书籍标签',     lambda r: r['crumbBadge'] >= 1 and '追更中' in r['badgeText']),
            ('书名后显示书签数 🔖2',   lambda r: '🔖2' in r['badgeText']),
            ('有书签的章节挂了 🔖',    lambda r: '🔖' in r['badgeText']),
            ('有「上次读到」提示条',   lambda r: r['strips'] == 1 and '上次读到' in r['stripText']),
            ('书签没有「改名」按钮',   lambda r: r['renameBtns'] == 0),
            ('目录上方有 3 个操作按钮', lambda r: r['pageActions'] == 3),
            ('顶栏那一项写着「我的标记」', lambda r: '我的标记' in r['navText']),
            ('点顶栏入口能打开面板',   lambda r: r['navOpens'] is True),
            ('我的标记有三个 subtab',  lambda r: r.get('tabCount') == 3),
            ('最近读的书排在列表最前', lambda r: (r.get('allListOrder') or [None])[0] == TID),
            ('评价 tab 列出了多本书（排序才有意义）',
             lambda r: len(r.get('allListOrder') or []) >= 2),
            ('页面链接没被挡住',       lambda r: not r['blockedLinks']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=dupbmk', '跨设备重复书签 → 合并后要去重', [
            ('同一位置只剩一条书签',   lambda r: r.get('dupLive') == 1),
            ('留下的是先创建的那条（确定性）',
             lambda r: r.get('dupSurvivor') == f'{TID}|{PIDS[1]}-1'),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=deleted', '删掉的书 → 详情页不该再显示进度', [
            ('没有「上次读到」提示条', lambda r: r['strips'] == 0),
            ('书名后也不挂 ▶ 进度',   lambda r: '▶' not in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/chapter_index', '纯目录列表页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('也认成了目录页',         lambda r: r['badges'] >= 3),
            ('章节角标画对了',         lambda r: '精彩' in r['badgeText'] and '跳过' in r['badgeText']),
            ('有「上次读到」提示条',   lambda r: r['strips'] == 1),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}', '正文页（一页多章）', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            (f'{len(PIDS)} 章都挂上了标记条', lambda r: r['bars'] == len(PIDS)),
            ('标记条上有三个标签钮',   lambda r: r['markBtns'] == len(PIDS) * 3),
            (f'每章都有书签钮',        lambda r: r['bmkBtns'] == len(PIDS)),
            ('已标章节高亮正确',       lambda r: '精彩' in r['barsText'] and '跳过' in r['barsText']),
            ('标出了「读到这里」',     lambda r: '读到这里' in r['barsText']),
            ('有书签的章节显示「🔖 书签 1」', lambda r: '🔖 书签 1' in r['barMarked']),
            ('没书签的章节只显示「🔖 书签」', lambda r: '🔖 书签' in r['barPlain'] and '书签 1' not in r['barPlain']),
            ('点 🔖 真能加上书签',     lambda r: r['clickTested'] and r['bmkAfterAdd'] == r['bmkSeeded'] + 1),
            ('加完立刻变「🔖 书签 1」', lambda r: '🔖 书签 1' in r['barAfterAdd']),
            ('同位置再点 = 取消',      lambda r: r['bmkAfterToggle'] == r['bmkSeeded']),
            # 「回去吗」确认栏横在底部时，不许把下面网站自己的链接挡死
            ('确认栏没挡住页面链接',   lambda r: not r['blockedLinks']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/posts/{PID_PROGRESS}', '单章固定链接页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('只认出 1 章（回帖没被算进来）', lambda r: r['bars'] == 1),
            ('标记条挂上了',           lambda r: r['markBtns'] == 3 and r['bmkBtns'] == 1),
            ('本章标签识别正确',       lambda r: '精彩' in r['barsText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=strip', '点「上次读到」→ 要带位置跳走，不是原地刷新', [
            ('点了会存下定位接力棒（旧版根本不存）',
             lambda r: bool(r.get('jumpPending'))),
            ('接力棒指向的是章节，不是书籍主页自己',
             lambda r: f'"cid":"{PID_PROGRESS}"' in (r.get('jumpPending') or '').replace(' ', '')),
            ('接力棒里带着章内位置，回去能复位',
             lambda r: '"cpct"' in (r.get('jumpPending') or '')),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}?fwtest=scroll', '读到一半 → 进度要及时换章并落盘', [
            ('确实滚过去了',           lambda r: r.get('scrollTested') is True),
            ('进度换成了滚到的那一章', lambda r: r.get('progAfterScroll') == PID_CLICK),
            ('进度里带着章内位置',     lambda r: r.get('progHasPos') is True),
            ('存储盖了 savedAt 时间戳（关页面兜底靠它选新的那份）',
             lambda r: (r.get('savedAt') or 0) > 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/posts/{PID_PROGRESS}?fwtest=landing', '跳转落地 → 自动复位到记录位置', [
            ('落地页认出了章节',       lambda r: r['bars'] == 1),
            ('自动滚到了记录位置',     lambda r: r['scrollY'] > 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/books?fwtest=legacy', '文库页 + v1.0 假数据迁移', [
            ('书名后挂了标签',         lambda r: r['bookItemBadge'] >= 1),
            ('标签内容正确',           lambda r: '追更中' in r['badgeText'] and '▶' in r['badgeText']),
            ('书名后显示书签数 🔖2',   lambda r: '🔖2' in r['badgeText']),
            ('两步迁移都跑过了',       lambda r: r['migFlag'] and r['migProgressCleared']),
            ('假章节记录已软删',       lambda r: r['migChapDeleted']),
            ('空壳假书已软删',         lambda r: r['migBookDeleted']),
            ('真书没被误删',           lambda r: r['migRealKept']),
            ('进度搬进了独立的 prog 表',
             lambda r: (r.get('progTable') or {}).get('cid') == PID_PROGRESS),
            ('书记录里不再残留 progress', lambda r: r.get('progLeftInBook') is False),
            ('假进度没被搬进新表（先被清掉了）', lambda r: r.get('progBogusMoved') is False),
            ('假书不再显示 ▶ 进度',    lambda r: '旧版假数据' not in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/collection/{UID}', '收藏页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('书名后挂上了标签',       lambda r: r['badges'] >= 1 and '列表验证' in r['badgeText']),
            ('页面链接一个都没被挡住', lambda r: not r['blockedLinks']),
            ('子 tab 点得到',          lambda r: r['tabReachable'] is True),
            ('点顶栏入口能打开面板',   lambda r: r['navOpens'] is True),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/', '首页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('书名后挂上了标签',       lambda r: r['badges'] >= 1 and '列表验证' in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/channels/1', '频道页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('书名后挂上了标签',       lambda r: r['badges'] >= 1 and '列表验证' in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/thread_index', '主题索引页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('书名后挂上了标签',       lambda r: r['badges'] >= 1 and '列表验证' in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/status_collection', '动态页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/users/{UID}/usercenter', '个人中心', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/tag', '标签云页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
    ]

    # --only <关键字>：只跑名字里含这个词的用例，调试时省时间
    only = None
    for i, a in enumerate(sys.argv):
        if a == '--only' and i + 1 < len(sys.argv):
            only = sys.argv[i + 1]
    if only:
        cases = [c for c in cases if only in c[1] or only in c[0]]
        print(f'（只跑含「{only}」的 {len(cases)} 个用例）')

    sp, st_, sfail = static_checks()
    total, passed = st_, sp
    failed_cases = list(sfail)
    for path, label, checks in cases:
        print(f'\n=== {label}  ({path}) ===')
        r, raw = dump(f'http://127.0.0.1:{PORT}{path}')
        if r is None:
            print('  × 页面没跑出结果，可能脚本抛异常了。原始输出尾部：')
            print('   ', raw[-400:].replace('\n', ' '))
            total += len(checks)
            failed_cases.append(label)
            continue
        for name, fn in checks:
            total += 1
            try:
                ok = fn(r)
            except Exception as e:
                ok = False
                name += f'（断言本身炸了：{e}）'
            passed += bool(ok)
            if not ok:
                failed_cases.append(f'{label} / {name}')
            print(f'  {"✅" if ok else "❌"} {name}')
        if r['jsErrors']:
            print('   JS 报错：', r['jsErrors'])
        if r.get('allListOrder') is not None:
            print('   列表顺序：', r['allListOrder'])
        if r.get('blockedLinks'):
            for b in r['blockedLinks']:
                print('   被挡：', b)

    print(f'\n{"=" * 44}\n{passed}/{total} 通过')
    if failed_cases:
        print('\n没过的：')
        for f in failed_cases:
            print('  ·', f)
    srv.shutdown()
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main() or 0)
