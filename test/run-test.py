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
DONE_TID = '999001'     # 用来验「已完结且读完的书不算在读」
DROP_TID = '999003'     # 用来验「打了弃坑的书排到进度栏最后、也不查新章」
# 两个页面数出来的章节数。写死是故意的 —— 夹具一变这条就会红，提醒去核对逻辑。
#
# 两者差 1 不是 bug：第 46 章是「单章限制阅读」，**只有书籍详情页列出来**，
# 目录列表页把它漏掉了。所以脚本以详情页为准（见 learnBookMeta / fetchCids）。
CHAP_TOTAL = 46          # /chapter_index 去重后
CHAP_TOTAL_PROFILE = 47  # /profile 去重后（权威值）
UPD_TID = '999002'      # 用来验「手动查新章」：种子里故意只记 3 章
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
            'chapTotal': 46, 'done': False, 'chapSeenAt': 1700000000000,
        },
        # 章节数过时（只记了 3 章）→ 点「查新章」应该去抓一次目录页更新它
        UPD_TID: {
            'id': UPD_TID, 'title': '待查新章的书', 'url': '', 'tags': [], 'review': '',
            'updatedAt': 1, 'chapTotal': 3, 'done': False, 'chapCheckedAt': 1,
        },
        # 已完结 + 读到最后一章 + 那一章也读完了 → 不该算「在读」
        DONE_TID: {
            'id': DONE_TID, 'title': '读完的书', 'url': '', 'tags': [], 'review': '',
            'updatedAt': 1, 'chapTotal': 5, 'done': True, 'chapSeenAt': 1700000000000,
        },
        # 打了「弃坑」→ 排在进度栏最后，不显示章节进度，也不参与查新章
        DROP_TID: {
            'id': DROP_TID, 'title': '弃坑的书', 'url': '', 'tags': ['弃坑'], 'review': '',
            'updatedAt': 1, 'chapTotal': 9, 'done': False,
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
            'no': 1,              # 读到第 1 章，全书 46 章 → 应显示 1/46 + 有新章 45
            # updatedAt 特意给大，用来验「最近读的排最前」
            'pct': 0.4, 'cpct': 0.55, 'anchor': '', 'ts': 1, 'updatedAt': 5000,
        },
        UPD_TID: {
            'bid': UPD_TID, 'cid': PID_PROGRESS, 'title': '第一章',
            'url': f'/posts/{PID_PROGRESS}', 'no': 1,
            'pct': 0.2, 'cpct': 0.2, 'anchor': '', 'ts': 1, 'updatedAt': 2000,
        },
        DONE_TID: {
            'bid': DONE_TID, 'cid': '9001', 'title': '5 最终章',
            'url': '/posts/9001', 'no': 5,
            'pct': 0.99, 'cpct': 0.97, 'anchor': '', 'ts': 1, 'updatedAt': 3000,
        },
        # updatedAt 特意给最大：就算「最近才读过」，弃坑了也得排最后
        DROP_TID: {
            'bid': DROP_TID, 'cid': '9003', 'title': '3 弃了',
            'url': '/posts/9003', 'no': 3,
            'pct': 0.3, 'cpct': 0.3, 'anchor': '', 'ts': 1, 'updatedAt': 9000,
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
    # 两个手动书签。书签是**章级**的：不起名字、也不记章内位置，
    # 认出「是哪一章」就够了
    'bmks': {
        f'{TID}|{PIDS[1]}-1': {
            'key': f'{TID}|{PIDS[1]}-1', 'bid': TID, 'cid': PIDS[1], 'title': '第二章',
            'url': f'/posts/{PIDS[1]}', 'createdAt': 2, 'updatedAt': 2,
        },
        f'{TID}|{PIDS[3]}-2': {
            'key': f'{TID}|{PIDS[3]}-2', 'bid': TID, 'cid': PIDS[3], 'title': '第四章',
            'url': f'/posts/{PIDS[3]}', 'createdAt': 1, 'updatedAt': 1,
        },
    },
    'tagPool': ['追更中', '甜文', '弃坑', '列表验证'],
    'site': {},
    'cfg': {'token': '', 'repo': '', 'repoDir': 'fw-marks', 'davDir': '', 'davUser': '', 'davPass': '', 'autoSync': False},
    'lastSync': 9999999999999,
    'status': {},
    # 默认就标成「已迁移」，否则测试台每开一页都重灌一次种子、
    # 迁移就又跑一遍，提示会没完没了地弹。
    # 想验迁移的用例走 ?fwtest=legacy，那时才把这些标记去掉
    'mig1': True,
    'mig2': True,
    'mig3': True,
    'mig4': True,
    'mig5': True,
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
      // 悬浮球必须彻底没有了 —— 它会压住网站自己的按钮
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
      // 章首那条标记条（章末还有一条一模一样的，另外数）
      markBtns: n('[data-fw-bar] [data-fw-mark]'),
      bmkBtns: n('[data-fw-bar] [data-fw-bmk]'),
      endBars: n('[data-fw-end]'),
      endMarkBtns: n('[data-fw-end] [data-fw-mark]'),
      endBmkBtns: n('[data-fw-end] [data-fw-bmk]'),
      // 章节内只留书签了 —— 备注的入口必须一个都不剩
      noteBtns: n('[data-fw-note]'),
      // 书名后那个「▶ 读到某章」要能点着跳回去
      jumpPills: n('[data-fw-jump]'),
      // 书签钮只留一个图标：标了的是亮的（带 data-fw-bmkon），没标的是灰的
      bmkOn: n('[data-fw-bar] [data-fw-bmk][data-fw-bmkon]'),
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
      // 目录页学到的书籍元数据（章节总数 / 完结状态 / 当前章序号）
      learnedTotal: real ? (real.chapTotal || null) : null,
      learnedCids: real ? (real.cids || []) : [],
      // 正文页面包屑上不该再挂角标
      crumbProg: (function () {
        var e = document.querySelector('a[href$="/threads/__TID__/profile"] [data-fw-badge]');
        return e ? e.textContent.trim() : '';
      })(),
      // 标记条上那条进度，整页只该有一条；它不跳转，点了是清掉进度
      barProgPills: n('[data-fw-bar] [data-fw-progdel]'),
      barProgJumps: n('[data-fw-bar] [data-fw-jump]'),
      // 最后一章正文末尾那个「我读完了」
      endText: txt('[data-fw-end]'),
      // 列表页：进度单独占一行、靠右；标签这些短的还是挂书名后
      listRows: n('[data-fw-rows]'),
      listRowsText: txt('[data-fw-rows]').slice(0, 400),
      listRowsFloat: (function () {
        var e = document.querySelector('[data-fw-rows]');
        return e ? getComputedStyle(e).cssFloat : '';
      })(),
      // 状态小条必须和一句话简介同一行（不自己另占一行把条目撑高）
      listRowsWithBrief: (function () {
        var e = document.querySelector('[data-fw-rows]');
        return !!(e && e.parentElement &&
          e.parentElement.querySelector('span.smaller-5'));
      })(),
      titleBadges: n('a[href*="/threads/"] > [data-fw-badge]'),
      // 书名（面包屑 / 大标题）后面那份角标的文字
      crumbBadgeText: txt('a[href$="/threads/__TID__/profile"] [data-fw-badge]').slice(0, 200),
      // 详情页：角标挂在站点那排标签的下一行
      metaBox: n('[data-fw-meta]'),
      metaText: txt('[data-fw-meta]').slice(0, 300),
      learnedDone: real ? (real.done === undefined ? null : real.done) : null,
      learnedNo: ((d.prog || {})['__TID__'] || {}).no || null,
      // v1.5：进度搬进独立的 prog 表，书记录里那个字段要消失
      progTable: (d.prog || {})['__TID__'] || null,
      progLeftInBook: real ? !!real.progress : null,
      progBogusMoved: !!(d.prog || {})['__BOGUS__'],

      // 有没有哪个部件把页面上的链接盖住了 —— 盖住了真站上也会「点不了」。
      // elementFromPoint 是唯一靠谱的判法，光看 CSS 说 display:none 不算数
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

    // 点顶栏那一项，面板得真的打开 —— 这是唯一的全站入口
    (function () {
      var a = document.querySelector('[data-fw-nav] [data-fw-open]');
      if (!a) { r.navOpens = null; return; }
      a.click();
      var h = document.getElementById('__fw_marks__');
      var sr = h && h.shadowRoot;
      var sh = sr ? sr.querySelector('.sheet') : null;
      r.navOpens = !!(sh && sh.classList.contains('on'));
      // 书评并进进度之后，只剩「进度」「书签」两个 tab
      r.tabCount = sr ? sr.querySelectorAll('.tabs [data-tab]').length : 0;
      r.rateTabGone = sr ? !sr.querySelector('[data-tab="rate"]') : null;
      // 进度 tab：验「第几章/共几章」、有新章标记、以及读完的书被分出去
      var progTab = sr ? sr.querySelector('[data-tab="prog"]') : null;
      if (progTab) progTab.click();
      r.progText = sr ? ((sr.querySelector('[data-list]') || {}).textContent || '') : '';
      r.progSub = sr ? ((sr.querySelector('.sheet header .sub') || {}).textContent || '') : '';
      r.progOrder = sr ? [].map.call(sr.querySelectorAll('[data-list] .book'),
        function (e) { return e.getAttribute('data-bid'); }) : [];
      // 取书 id 而不是书名 —— 书名会被页面上的真实标题覆盖（noteBook 会更新它）
      r.allListOrder = r.progOrder;
      // 分组标题（读完了 / 没有进度 / 弃坑），点一下收起
      r.grpTitles = sr ? [].map.call(sr.querySelectorAll('[data-fold]'),
        function (e) { return e.getAttribute('data-fold'); }) : [];
      var fd = sr ? sr.querySelector('[data-fold="finished"]') : null;
      if (fd) fd.click();
      r.foldHidesDone = sr ? !sr.querySelector('[data-list] .book[data-bid="__DONE__"]') : null;
      r.foldSaved = !!(((db().cfg || {}).fold || {}).finished) ||
        !!((window.__fw && window.__fw.DB.d.cfg.fold || {}).finished);
      fd = sr ? sr.querySelector('[data-fold="finished"]') : null;
      if (fd) fd.click();      // 展开回来，别影响后面的断言
      r.unfoldShowsDone = sr ? !!sr.querySelector('[data-list] .book[data-bid="__DONE__"]') : null;
      // 写好的书评是纯文本，不是一直摆着的输入框；铅笔点开才有输入框
      r.rateRvText = sr ? ((sr.querySelector('.book .rv') || {}).textContent || '') : '';
      r.rateFirstTitle = sr ? ((sr.querySelector('.book .bt') || {}).textContent || '') : '';
      r.rateTextareas = sr ? sr.querySelectorAll('.rvedit').length : 0;
      r.ratePens = sr ? sr.querySelectorAll('[data-pen]').length : 0;
      var pen = sr ? sr.querySelector('[data-pen]') : null;
      if (pen) pen.click();
      r.penBoxes = sr ? sr.querySelectorAll('.rvbox .rvedit').length : 0;
      r.penTags = sr ? sr.querySelectorAll('.rvbox [data-btag]').length : 0;
      var cls = h && h.shadowRoot ? h.shadowRoot.querySelector('.cls') : null;
      if (cls) cls.click();   // 关回去，别影响后面的断言
    })();

    /* 模式一：点「上次读到」提示条。
     *
     * 麻烦在于点了就会跳转，文档一被换走，dump-dom 就什么都取不到。
     * 办法：临时钩住 Storage.setItem 截下脚本存的「定位接力棒」，
     * 然后马上 window.stop() 把这次跳转掐掉，原地交结果。
     *
     * 以前是再赋一次 location.href 跳去取结果页、指望后一次跳转盖掉前一次 ——
     * 那是在赌时序：页面一加载上真样式表，两次跳转都发出去了，Chrome 卡在中间
     * 一个字都不吐（实测，查了好一阵）。掐掉跳转就没有这个赛跑了。
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
        window.stop();
        Storage.prototype.setItem = origSet;
        r.jumpPending = cap || '';
        return finish();
      }
    }

    /* 模式零：查新章是**手动**的。
     * 先确认没人点的时候章节数一动不动（不后台偷跑），
     * 再点「🔄 查一下有没有新章」，看过时的章节数有没有被更新。 */
    if (location.search.indexOf('fwtest=upd') >= 0) {
      r.updBefore = ((db().books || {})['__UPD__'] || {}).chapTotal || null;
      var h2 = document.getElementById('__fw_marks__');
      var sr2 = h2 && h2.shadowRoot;
      var nav2 = document.querySelector('[data-fw-nav] [data-fw-open]');
      if (nav2) nav2.click();
      var pt = sr2 ? sr2.querySelector('[data-tab="prog"]') : null;
      if (pt) pt.click();
      var btn2 = sr2 ? sr2.querySelector('[data-act="chkupd"]') : null;
      r.updBtn = !!btn2;
      if (btn2) btn2.click();
      setTimeout(function () {
        var bk = (db().books || {})['__UPD__'] || {};
        r.updTotal = bk.chapTotal || null;
        r.updCheckedAt = bk.chapCheckedAt || null;
        r.updCids = (bk.cids || []).length;
        finish();
      }, 5000);
      return;
    }

    /* 黑夜模式：网页、面板一起暗；我们自己的彩色小条不能被洗成灰的；
     * 面板头上的 🌙 能一键关掉，并且记住（下次开页面靠它抢在画出来之前套上） */
    if (location.search.indexOf('fwtest=dark') >= 0) {
      var hd = document.getElementById('__fw_marks__');
      r.darkStyle = !!document.getElementById('__fw_dark__');
      r.darkBodyBg = getComputedStyle(document.body).backgroundColor;
      r.darkHost = !!(hd && hd.classList.contains('dark'));
      r.darkFlag = localStorage.getItem('__fwm__dark');
      var pillEl = document.querySelector('[data-fw-jump]');
      r.darkPillBg = pillEl ? getComputedStyle(pillEl).backgroundColor : '';
      r.darkSheetBg = hd && hd.shadowRoot
        ? getComputedStyle(hd.shadowRoot.querySelector('.sheet')).backgroundColor : '';
      // 带 &keep 是截图用：保持黑着，不去验关掉那一步（再带 &panel 就把面板也开着）
      if (location.search.indexOf('keep') >= 0) {
        if (location.search.indexOf('panel') >= 0) {
          var nv2 = document.querySelector('[data-fw-nav] [data-fw-open]');
          if (nv2) nv2.click();
        }
        return finish();
      }
      var moon = hd && hd.shadowRoot && hd.shadowRoot.querySelector('.moon');
      if (moon) moon.click();
      r.darkOffStyle = !!document.getElementById('__fw_dark__');
      r.darkOffFlag = localStorage.getItem('__fwm__dark');
      return finish();
    }

    // 截图用：把「我的标记」开着不关（--shot 时看面板长什么样）
    if (location.search.indexOf('fwtest=openpanel') >= 0) {
      var nv = document.querySelector('[data-fw-nav] [data-fw-open]');
      if (nv) nv.click();
      return finish();
    }

    /* 云端的进度只到「第几章」：章内位置只留本机。
     * 直接调同步层（测试台上 window.__fw 挂着内部对象），不用真连云端。 */
    if (location.search.indexOf('fwtest=cloudprog') >= 0) {
      var F = window.__fw;
      if (!F) { r.cloudHook = false; return finish(); }
      r.cloudHook = true;
      var body = JSON.parse(F.Sync.fileText('prog.json')).data['__TID__'] || {};
      r.cloudKeys = Object.keys(body).sort().join(',');
      // 同一章里滚动（只动章内位置）→ 云端那份一个字都不该变
      var before = F.Sync.fileText('prog.json');
      var lp = F.DB.d.prog['__TID__'];
      lp.cpct = 0.91; lp.anchor = '换了一句'; lp.updatedAt = Date.now();
      r.cloudSameAfterScroll = F.Sync.fileText('prog.json') === before;
      // 云端是同一章、时间更新 → 本机的章内位置得留着
      F.Sync.applyFile('prog.json', { v: 1, data: { '__TID__': {
        bid: '__TID__', cid: lp.cid, title: '云端同一章', url: '', no: 1,
        deleted: false, updatedAt: 9e12 } } });
      r.keptCpctSameChap = F.DB.d.prog['__TID__'].cpct;
      // 云端换了章 → 本机采纳，章内位置作废（从章首开始）
      F.Sync.applyFile('prog.json', { v: 1, data: { '__TID__': {
        bid: '__TID__', cid: '__PID_CLICK__', title: '云端新的一章', url: '', no: 3,
        deleted: false, updatedAt: 9.5e12 } } });
      var after = F.DB.d.prog['__TID__'];
      r.newChapCid = after.cid;
      r.newChapHasPos = typeof after.cpct === 'number';
      // 云端比本机旧 → 不理它
      F.Sync.applyFile('prog.json', { v: 1, data: { '__TID__': {
        bid: '__TID__', cid: '__PID_BMK__', title: '旧的', url: '', no: 2,
        deleted: false, updatedAt: 5 } } });
      r.oldIgnored = F.DB.d.prog['__TID__'].cid === '__PID_CLICK__';
      return finish();
    }

    /* 模式五：在进度 tab 里点标签 —— 要立刻生效，不用刷新页面。 */
    if (location.search.indexOf('fwtest=tagclick') >= 0) {
      var h3 = document.getElementById('__fw_marks__');
      var sr3 = h3 && h3.shadowRoot;
      var nav3 = document.querySelector('[data-fw-nav] [data-fw-open]');
      if (nav3) nav3.click();
      var pt3 = sr3 && sr3.querySelector('[data-tab="prog"]');
      if (pt3) pt3.click();
      r.tagProgListed = sr3 ? sr3.querySelectorAll('.book[data-bid="__TID__"]').length : 0;
      var pen3 = sr3 && sr3.querySelector('[data-pen="__TID__"]');
      r.tagPen = !!pen3;
      if (pen3) pen3.click();
      var chip = sr3 && sr3.querySelector('[data-btag="弃坑"][data-bk="__TID__"]');
      r.tagChip = !!chip;
      var order = function () {
        return sr3 ? [].map.call(sr3.querySelectorAll('[data-list] .book'),
          function (e) { return e.getAttribute('data-bid'); }) : [];
      };
      var posBefore = order().indexOf('__TID__');
      if (chip) chip.click();
      setTimeout(function () {
        var c2 = sr3 && sr3.querySelector('[data-btag="弃坑"][data-bk="__TID__"]');
        r.tagChipOn = !!(c2 && c2.classList.contains('on'));
        r.tagInStore = (((db().books || {})['__TID__'] || {}).tags || []).indexOf('弃坑') >= 0;
        // 编辑框还开着 → 这本书原地不动，不着急挪去弃坑组
        r.tagStayedPut = order().indexOf('__TID__') === posBefore;
        r.tagEditorStillOpen = !!(sr3 && sr3.querySelector('[data-rv="__TID__"]'));
        var done = sr3 && sr3.querySelector('[data-pendone="__TID__"]');
        if (done) done.click();
        var o2 = order();
        // 写好了 → 才挪去弃坑组（排最后）
        r.tagMovedAfterDone = o2[o2.length - 1] === '__TID__';
        r.tagRateListed = sr3 ? sr3.querySelectorAll('.book[data-bid="__TID__"]').length : 0;
        // 卡片书名那行里「弃坑」只该出现一次（标签那一个），不再多一个状态标
        r.tagRateTitle = sr3 ? ((sr3.querySelector('.book[data-bid="__TID__"] .bt')
          || {}).textContent || '') : '';
        finish();
      }, 600);
      return;
    }

    /* 模式四：跨标签页写入不许互相冲掉。
     * 直接改存储，假装「另一个标签页刚把进度记到了别的一章」，
     * 然后让本页也存一次 —— 整包覆盖的写法会把它冲掉，
     * 逐条合并的写法会留下时间戳更新的那条。
     * 这正是「详情页点进章节读完返回，进度没了」那个 bug 的机制。 */
    if (location.search.indexOf('fwtest=crosstab') >= 0) {
      var d0 = db();
      d0.prog = d0.prog || {};
      d0.prog['__TID__'] = {
        bid: '__TID__', cid: '__PID_CLICK__', title: '另一个标签页记的',
        url: '/posts/__PID_CLICK__', pct: 0.9, cpct: 0.9, anchor: '',
        ts: 9, updatedAt: 9e12,
      };
      d0.savedAt = 9e12;
      localStorage.setItem('__fwm__db', JSON.stringify(d0));
      // 触发本页的一次写入：给某一章打个标记就会存
      var mk = document.querySelector('[data-fw-mark="ok"][data-fw-pid="__PID_CLICK__"]');
      r.crossTriggered = !!mk;
      if (mk) mk.click();
      setTimeout(function () {
        var pg = (db().prog || {})['__TID__'] || {};
        r.crossCid = pg.cid || null;
        r.crossTitle = pg.title || '';
        // 本页自己那次写入也得真的落下来，不能为了保别人的就把自己丢了
        r.crossOwnWrite = !!((db().chaps || {})['__TID__|__PID_CLICK__'] || {}).mark;
        finish();
      }, 900);
      return;
    }

    /* 模式三：滚到别的一章，看进度有没有及时换过去并落盘。
     * 「读到一半关掉、进度没更新」就是这条路上出的问题：
     * 防抖挂太久 + GM 存储是异步的，关页面那一刻两头都还没落地 */
    if (location.search.indexOf('fwtest=postrec') >= 0) {
      var pr = (db().prog || {})['__TID__'] || {};
      r.postRecCid = pr.cid || null;
      r.postRecHasPos = typeof pr.cpct === 'number';
      r.savedAt = db().savedAt || 0;
      return finish();
    }

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
      r.bmkOnAfterAdd = n('[data-fw-bar] [data-fw-bmk][data-fw-bmkon]');
      // 章末那条也得跟着亮 —— 两条是同一份数据
      r.endBmkOnAfterAdd = n('[data-fw-end] [data-fw-bmk][data-fw-bmkon]');
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
   .replace('__PID_BMK__', PIDS[1]).replace('__PID_CLICK__', PID_CLICK) \
   .replace('__UPD__', UPD_TID).replace('__DONE__', DONE_TID)


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
        # 模拟两台设备各自给「同一章」加过书签：key 不同（key 带时间戳）。
        # 书签是章级的，同章就算重复 —— 去重应该只留一条，
        # 而且留的必须是 createdAt 更早的那条（确定性，不然两台设备来回删）
        data = json.loads(json.dumps(SEED))
        data.pop('mig3', None)
        data.pop('mig5', None)
        base = dict(SEED['bmks'][f'{TID}|{PIDS[1]}-1'])
        later = dict(base)
        later.update({'key': f'{TID}|{PIDS[1]}-999',
                      'createdAt': 9999, 'updatedAt': 9999})
        data['bmks'][f'{TID}|{PIDS[1]}-999'] = later

    elif 'fwtest=lastchap' in query:
        # 让本页最后一章正好是全书最后一章 → 该冒出「✓ 我读完了」
        data = json.loads(json.dumps(SEED))
        data['books'][TID]['cids'] = PIDS
        data['books'][TID]['chapTotal'] = len(PIDS)
        data['books'][TID]['doneRead'] = False

    elif 'fwtest=listprog' in query:
        # 列表页上的书都带一条进度，看状态小条摆在哪
        data = json.loads(json.dumps(SEED))
        for _i, _tid in enumerate(LIST_TIDS.values()):
            data['prog'][_tid] = {
                'bid': _tid, 'cid': '1', 'title': '某一章 名字故意起得很长很长很长',
                'url': '/posts/1', 'no': 3 + _i, 'pct': 0.5, 'cpct': 0.5,
                'anchor': '', 'ts': 1, 'updatedAt': 100 + _i,
            }
            data['books'][_tid]['chapTotal'] = 112
        # 文库页上那本（TID）也给个总章数，方便看「第几章/共几章」
        data['books'][TID]['chapTotal'] = 76

    elif 'fwtest=postrec' in query:
        # 进度原本记在别的章上；打开单章页之后就该换成这一章
        data = json.loads(json.dumps(SEED))
        data['prog'][TID]['cid'] = PIDS[3]
        data['prog'][TID]['title'] = '第四章'

    elif 'fwtest=dark' in query:
        data = json.loads(json.dumps(SEED))
        data['cfg']['dark'] = True

    elif 'fwtest=tagclick' in query:
        # 书记录被软删过、但进度还活着（老数据里真实存在这种）。
        # 进度 tab 靠 prog 表列，所以看得见；而书评 tab 走 liveBooks()，就看不见 ——
        # 在进度里给它打标签之后，两边都得立刻跟上，不该要刷新页面
        data = json.loads(json.dumps(SEED))
        data['books'][TID]['deleted'] = True
        data['books'][TID]['tags'] = []
        data['books'][TID]['review'] = ''

    elif 'fwtest=cidsowned' in query:
        # 已经从详情页学过章节列表了（里面有一章是目录列表页不列的「限阅」章，
        # 这里用一个假 id 代替）。目录列表页要把新章**合并**进来，
        # 但不许把那个「只有详情页才有」的章弄丢
        data = json.loads(json.dumps(SEED))
        data['books'][TID]['cids'] = PIDS[:3] + ['9999999']
        data['books'][TID]['chapTotal'] = 4

    elif 'fwtest=progcleared' in query:
        # 在「我的标记 → 进度」里点了「清除进度」之后，详情页不该还显示「上次读到」
        data = json.loads(json.dumps(SEED))
        data['prog'][TID]['deleted'] = True

    elif 'fwtest=ratecleared' in query:
        # 点了「清除书评」——标签、书评、章节标记都清掉，
        # 但**书签和进度必须还在**（三者互相独立）
        data = json.loads(json.dumps(SEED))
        data['books'][TID]['tags'] = []
        data['books'][TID]['review'] = ''
        for _k in list(data['chaps']):
            if _k.startswith(TID + '|'):
                data['chaps'][_k]['deleted'] = True

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
    # 站点样式表指到本地那份（test/assets/app.css，没有就是朴素排版，功能照跑）
    html = re.sub(r'https://[a-z0-9]+\.cloudfront\.net/css/(app\.css)\?[^"]*', r'/__assets__/\1', html)
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

        # 站点自己的样式表（本地缓存一份）。有了它夹具才是真实排版 ——
        # 不然 bootstrap 的栅格都不生效，「靠右」「同一行」这类断言根本没法验
        if path.startswith('/__assets__/'):
            f = os.path.join(HERE, 'assets', os.path.basename(path))
            if os.path.exists(f):
                with open(f, 'rb') as fh:
                    return self._send(fh.read(), 'text/css; charset=utf-8')
            return self._send('', 'text/css; charset=utf-8', 404)

        # 样式表里引的字体（/fonts/vendor/...）本地没有，回干脆的 404。
        # 不然会落到下面「没夹具的页面」那条路上，回一整页 HTML 外加注入的脚本 ——
        # 浏览器拿它当字体解，还在要真跳页面的用例里把 Chrome 卡住（实测）
        if path.startswith('/fonts/'):
            return self._send('', 'text/plain', 404)

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


def shot(url, out, width=390, height=1400):
    """跑一次 headless Chrome 截图（iPhone 宽度）。
    排版、颜色这类事断言写不全，得用眼睛看 —— python3 test/run-test.py --shot <路径> <out.png>"""
    import shutil
    import tempfile
    import time
    profile = tempfile.mkdtemp(prefix='fw-shot-profile-')
    if os.path.exists(out):
        os.unlink(out)        # 不删的话下面一看「文件已存在」就收工了，拿到的是上一张
    with open(os.devnull, 'w') as fe:
        p = subprocess.Popen(
            [CHROME, '--headless=old', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
             '--no-first-run', '--no-default-browser-check', '--disable-extensions',
             '--disable-component-update', '--user-data-dir=' + profile,
             f'--window-size={width},{height}', '--force-device-scale-factor=2',
             '--virtual-time-budget=6000', '--screenshot=' + out, url],
            stdout=fe, stderr=fe)
        for _ in range(60):
            time.sleep(0.5)
            if os.path.exists(out) and os.path.getsize(out) > 0 and p.poll() is not None:
                break
            if os.path.exists(out) and os.path.getsize(out) > 0:
                time.sleep(1)
                break
        p.kill()
    shutil.rmtree(profile, ignore_errors=True)
    return os.path.exists(out)


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
    # 分表同步：文件清单要从 COLLECTIONS 推导，别写死 —— 否则以后加表会忘
    checks.append(('同步文件清单从 COLLECTIONS 推导',
                   'COLLECTIONS.map((k) => k + \'.json\')' in s))
    # 每个文件的内容也必须是白名单式的，不能把 cfg 带进去
    body = body_of(r'fileBody\(name\)\s*\{.*?\n    \},')
    checks.append(('同步文件内容里不含凭据',
                   bool(body) and not any(x in code_only(body) for x in ('cfg', 'token', 'davPass'))))
    checks.append(('同步的表清单是白名单，且不含 cfg',
                   bool(coll) and 'cfg' not in coll and
                   set(coll) == {'books', 'chaps', 'bmks', 'prog'}))
    # 写回存储前必须逐条合并。整包覆盖会让「别的标签页/页面缓存里那份」
    # 把刚记的进度冲掉 —— 这是实打实出过的 bug，钉住它
    flushb = code_only(body_of(r'_flush\(\)\s*\{.*?\n    \},'))
    checks.append(('写回存储前先逐条合并（不整包覆盖）',
                   bool(flushb) and 'mergeStored' in flushb and 'GMx.set' in flushb))
    # 查新章只能手动触发，不许挂定时器后台偷跑
    checks.append(('查新章没有后台定时器',
                   not re.search(r'setTimeout\([^;]{0,80}checkUpdates', s)))

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

    if '--shot' in sys.argv:
        i = sys.argv.index('--shot')
        path, out = sys.argv[i + 1], sys.argv[i + 2]
        w = int(sys.argv[i + 3]) if len(sys.argv) > i + 3 and sys.argv[i + 3].isdigit() else 390
        ok = shot(f'http://127.0.0.1:{PORT}{path}', out, width=w)
        print('截图', '好了：' + out if ok else '失败')
        return 0 if ok else 1

    if not os.path.exists(CHROME):
        print('× 没找到 Chrome。可以改用 python3 test/run-test.py --serve 手动在浏览器里看')
        return 1

    cases = [
        (f'/threads/{TID}/profile', '书籍介绍 + 目录页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('目录角标画出来了',       lambda r: r['badges'] >= 3),
            ('角标里有章节标签',       lambda r: '精彩' in r['badgeText'] and '跳过' in r['badgeText']),
            # 角标挪到站点那排标签的下一行了，面包屑和大标题都不挂
            ('角标挂在站点标签的下一行', lambda r: r['metaBox'] == 1
             and '追更中' in r['metaText']),
            ('面包屑和大标题都不挂角标', lambda r: r['crumbBadge'] == 0),
            ('那一行里有书签数 🔖2',   lambda r: '🔖2' in r['metaText']),
            ('有书签的章节挂了 🔖',    lambda r: '🔖' in r['badgeText']),
            ('有「上次读到」提示条',   lambda r: r['strips'] == 1 and '上次读到' in r['stripText']),
            ('书签没有「改名」按钮',   lambda r: r['renameBtns'] == 0),
            ('目录上方有 3 个操作按钮', lambda r: r['pageActions'] == 3),
            ('顶栏那一项写着「我的标记」', lambda r: '我的标记' in r['navText']),
            ('点顶栏入口能打开面板',   lambda r: r['navOpens'] is True),
            ('只剩进度、书签两个 tab', lambda r: r.get('tabCount') == 2
             and r.get('rateTabGone') is True),
            ('进度显示「当前章/总章数」',
             lambda r: re.search(r'\d+/\d+', r.get('progText', '')) is not None),
            ('有新章会标出来',         lambda r: '有新章' in r.get('progText', '')),
            ('介绍页也能学到连载状态', lambda r: r.get('learnedDone') is False),
            ('介绍页是章节数的权威来源（含限阅那一章）',
             lambda r: r.get('learnedTotal') == CHAP_TOTAL_PROFILE
             and len(r.get('learnedCids') or []) == CHAP_TOTAL_PROFILE),
            ('读完的书归到「读完了」',  lambda r: '读完了' in r.get('progText', '')
             and '✓ 读完' in r.get('progText', '')),
            # 种子里 4 本有进度：TID / UPD_TID 在读，DONE_TID 读完，DROP_TID 弃坑
            ('在读算 2 本', lambda r: '2 本在读' in r.get('progSub', '')),
            ('进度 tab 里书名后也有铅笔', lambda r: '✏️' in r.get('progText', '')),
            # 弃坑的排最后（即使它 updatedAt 最大），读完的排在它前面
            ('弃坑的排在进度栏最后',
             lambda r: (r.get('progOrder') or [None])[-1] == DROP_TID),
            ('读完的排在弃坑之前',
             lambda r: (r.get('progOrder') or []).index(DONE_TID)
             < (r.get('progOrder') or []).index(DROP_TID)),
            ('读完 / 弃坑 不显示章节进度',
             lambda r: '5/5' not in r.get('progText', '')
             and '3/9' not in r.get('progText', '')),
            ('分组计数写全了',         lambda r: '1 本读完' in r.get('progSub', '')
             and '1 本弃坑' in r.get('progSub', '')),
            ('「已读完」按钮文案就叫已读完',
             lambda r: '已读完' in r.get('progText', '')
             and '标已读完' not in r.get('progText', '')),
            ('最近读的书排在列表最前', lambda r: (r.get('allListOrder') or [None])[0] == TID),
            ('进度 tab 列出了多本书（排序才有意义）',
             lambda r: len(r.get('allListOrder') or []) >= 2),
            # 书评并进来之后，没进度但打过标签的书也得在这儿（「没有进度」那组）
            ('没进度但评过的书也列出来了',
             lambda r: LIST_TIDS['home'] in (r.get('allListOrder') or [])),
            ('读完 / 没有进度 / 弃坑 三组有分组标题',
             lambda r: set(r.get('grpTitles') or []) >= {'finished', 'none', 'dropped'}),
            ('点分组标题能收起来，并记住', lambda r: r.get('foldHidesDone') is True
             and r.get('foldSaved') is True),
            ('再点一下展开回来',       lambda r: r.get('unfoldShowsDone') is True),
            ('写好的书评显示成文本',   lambda r: '总评测试' in r.get('rateRvText', '')),
            ('没点铅笔时不摆输入框',   lambda r: r.get('rateTextareas') == 0),
            ('每本书名后都有铅笔',     lambda r: (r.get('ratePens') or 0) >= 1),
            # 书评 tab 的书名后也标一下进度
            ('书名后标了进度',
             lambda r: re.search(r'\d+/\d+|读完', r.get('rateFirstTitle', '')) is not None),
            ('点铅笔就展开书评框 + 标签',
             lambda r: r.get('penBoxes') == 1 and (r.get('penTags') or 0) >= 1),
            ('书名后的进度条能点着跳', lambda r: (r.get('jumpPills') or 0) >= 1),
            ('页面链接没被挡住',       lambda r: not r['blockedLinks']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/chapter_index?fwtest=cidsowned',
         '详情页学过之后 → 目录列表页把新章合并进来', [
            ('新章都合并进来了',     lambda r: r.get('learnedTotal') == CHAP_TOTAL + 1),
            ('详情页才有的那章还在', lambda r: '9999999' in (r.get('learnedCids') or [])),
            ('没有 JS 报错',        lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=cidsowned',
         '详情页自己则一律重新学', [
            ('详情页会把章节数改成自己数出来的',
             lambda r: r.get('learnedTotal') == CHAP_TOTAL_PROFILE),
            ('没有 JS 报错',        lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=dupbmk', '跨设备重复书签 → 合并后要去重', [
            ('同一位置只剩一条书签',   lambda r: r.get('dupLive') == 1),
            ('留下的是先创建的那条（确定性）',
             lambda r: r.get('dupSurvivor') == f'{TID}|{PIDS[1]}-1'),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=progcleared', '清除进度 → 详情页不再显示进度', [
            ('没有「上次读到」提示条', lambda r: r['strips'] == 0),
            ('书名后也不挂 ▶ 进度',   lambda r: '▶' not in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=ratecleared', '清除书评 → 书签和进度必须还在', [
            ('进度提示条还在',         lambda r: r['strips'] == 1),
            ('书名后还挂着 ▶ 进度',    lambda r: '▶' in r['badgeText']),
            ('书签角标还在',           lambda r: '🔖' in r['badgeText']),
            ('标签确实清掉了',         lambda r: '追更中' not in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/chapter_index', '纯目录列表页', [
            # 这一页没有站点标签行，也不该把进度写到标题上 ——
            # 底下那条「上次读到…点这里继续」已经说清楚了
            ('标题上不写进度',         lambda r: '▶' not in r['crumbBadgeText']),
            ('但标签照旧挂着',         lambda r: '追更中' in r['crumbBadgeText']),
            # 还没从详情页学过时，这一页兜底，学到的就是它自己去重后的章节数
            ('没学过时目录列表页兜底',
             lambda r: r.get('learnedTotal') == CHAP_TOTAL),
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
            # 章末也有一条一样的标记条，读完一章不用滚回章首
            ('每章末尾也有一条标记条', lambda r: r['endBars'] == len(PIDS)
             and r['endMarkBtns'] == len(PIDS) * 3 and r['endBmkBtns'] == len(PIDS)),
            ('已标章节高亮正确',       lambda r: '精彩' in r['barsText'] and '跳过' in r['barsText']),
            # 「读到哪一章」由面包屑上那个进度小条说明，标记条上不再写红字
            ('标记条上没有「读到这里」红字', lambda r: '读到这里' not in r['barsText']),
            # 进度小条挪到标记条上、书签钮后面了（面包屑是网站自己的东西，不去挤）
            ('面包屑上不挂进度了',     lambda r: r['crumbProg'] == ''),
            ('标记条上只挂一条进度',   lambda r: r['barProgPills'] == 1),
            # 人就在书里读着，跳回「读到的位置」等于原地打转 —— 所以这条不跳转
            ('那条进度不是跳转链',     lambda r: r['barProgJumps'] == 0),
            # 书签钮只留图标，不写字（标了是亮的、没标是灰的）
            ('书签钮只有图标、没有文字', lambda r: '🔖' in r['barsText']
             and '书签' not in r['barsText']),
            ('只有加过书签的那两章是亮的', lambda r: r['bmkOn'] == 2),
            # 章节内只留书签：备注的入口（会弹面板要打字的那个钮）全撤了
            ('章节内没有「备注」按钮了', lambda r: r['noteBtns'] == 0
             and '备注' not in r['barsText']),
            ('点 🔖 真能加上书签',     lambda r: r['clickTested'] and r['bmkAfterAdd'] == r['bmkSeeded'] + 1),
            ('加完那一章的图标立刻亮起来', lambda r: r.get('bmkOnAfterAdd') == 3),
            ('章末那条也跟着亮',       lambda r: r.get('endBmkOnAfterAdd') == 3),
            ('同位置再点 = 取消',      lambda r: r['bmkAfterToggle'] == r['bmkSeeded']),
            # 「回去吗」确认栏横在底部时，不许把下面网站自己的链接挡死
            ('确认栏没挡住页面链接',   lambda r: not r['blockedLinks']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/posts/{PID_PROGRESS}', '单章固定链接页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('只认出 1 章（回帖没被算进来）', lambda r: r['bars'] == 1),
            ('标记条挂上了',           lambda r: r['markBtns'] == 3 and r['bmkBtns'] == 1),
            ('章末也挂了一条',         lambda r: r['endBars'] == 1),
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
        # 论坛模式（/threads/{id}，一页多章夹着回帖）多半是在翻评论 ——
        # 在那儿滚两下不许把进度挪走
        (f'/threads/{TID}?fwtest=scroll', '论坛模式里滚动 → 不许挪进度', [
            ('确实滚过去了',           lambda r: r.get('scrollTested') is True),
            ('进度还是原来那一章',     lambda r: r.get('progAfterScroll') == PID_PROGRESS),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/posts/{PID_PROGRESS}?fwtest=postrec', '单章页 → 进度要记下来并落盘', [
            ('进度换成了这一章',       lambda r: r.get('postRecCid') == PID_PROGRESS),
            ('进度里带着章内位置',     lambda r: r.get('postRecHasPos') is True),
            ('存储盖了 savedAt 时间戳（关页面兜底靠它选新的那份）',
             lambda r: (r.get('savedAt') or 0) > 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}?fwtest=upd', '手动查新章（不用点开每本书）', [
            ('没点之前不后台偷查',   lambda r: r.get('updBefore') == 3),
            ('进度 tab 里有「查新章」按钮', lambda r: r.get('updBtn') is True),
            ('点了之后章节数被更新成详情页那份',
             lambda r: r.get('updTotal') == CHAP_TOTAL_PROFILE
             and r.get('updCids') == CHAP_TOTAL_PROFILE),
            ('记下了这次查过的时间', lambda r: (r.get('updCheckedAt') or 0) > 1),
            ('没有 JS 报错',        lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}?fwtest=tagclick', '进度 tab 里打弃坑 → 写好了才挪组', [
            ('进度 tab 列出了这本',   lambda r: r.get('tagProgListed') == 1),
            ('书名后有铅笔',          lambda r: r.get('tagPen') is True),
            ('编辑块里有标签格子',    lambda r: r.get('tagChip') is True),
            ('点完标签真写进存储了',  lambda r: r.get('tagInStore') is True),
            ('格子立刻变成选中态',    lambda r: r.get('tagChipOn') is True),
            # 编辑框开着时点了「弃坑」，卡片原地不动；点「写好了」才挪到弃坑组
            ('编辑框开着时原地不动',  lambda r: r.get('tagStayedPut') is True
             and r.get('tagEditorStillOpen') is True),
            ('写好了之后才挪去弃坑组', lambda r: r.get('tagMovedAfterDone') is True),
            ('书名那行弃坑只出现一次',
             lambda r: r.get('tagRateTitle', '').count('弃坑') == 1
             and '✕' not in r.get('tagRateTitle', '')),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/collection/{UID}?fwtest=tagclick',
         '进度 tab 里打标签（书记录被软删过、且这一页不会自愈）', [
            ('进度 tab 列出了这本',   lambda r: r.get('tagProgListed') == 1),
            ('点完标签真写进存储了',  lambda r: r.get('tagInStore') is True),
            ('格子立刻变成选中态',    lambda r: r.get('tagChipOn') is True),
            ('写好了之后标签显示出来了', lambda r: r.get('tagRateListed') == 1
             and '弃坑' in r.get('tagRateTitle', '')),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}?fwtest=lastchap', '最后一章 → 正文末尾也有「我读完了」', [
            # 读完那一刻人就在末尾，章首那条不用再放
            ('章首那条里没有',       lambda r: '我读完了' not in r['barsText']),
            ('只有最后那一章末尾有', lambda r: r.get('endText', '').count('我读完了') == 1),
            ('没有 JS 报错',        lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=cloudprog', '云端进度只到「第几章」', [
            ('测试挂钩在',             lambda r: r.get('cloudHook') is True),
            ('云端那份不带章内位置',
             lambda r: not any(k in r.get('cloudKeys', '').split(',')
                               for k in ('cpct', 'pct', 'anchor'))),
            ('同一章里滚动，云端那份不变（不推）', lambda r: r.get('cloudSameAfterScroll') is True),
            ('云端同一章更新 → 本机章内位置留着', lambda r: r.get('keptCpctSameChap') == 0.91),
            ('云端换了章 → 采纳，从章首开始',
             lambda r: r.get('newChapCid') == PID_CLICK and r.get('newChapHasPos') is False),
            ('云端比本机旧 → 不理',    lambda r: r.get('oldIgnored') is True),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}/profile?fwtest=dark', '黑夜模式', [
            ('网页套上了深色样式',     lambda r: r.get('darkStyle') is True
             and r.get('darkBodyBg') == 'rgb(20, 20, 22)'),
            ('面板也暗了',             lambda r: r.get('darkHost') is True
             and r.get('darkSheetBg') == 'rgb(28, 28, 31)'),
            ('我们的彩色小条没被洗灰', lambda r: r.get('darkPillBg') == 'rgb(232, 85, 78)'),
            ('记下了，下次开页面能抢先套上', lambda r: r.get('darkFlag') == '1'),
            ('点 🌙 一键关掉',         lambda r: r.get('darkOffStyle') is False
             and r.get('darkOffFlag') == '0'),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/threads/{TID}?fwtest=crosstab', '两个标签页同时写 → 不许互相冲掉', [
            ('确实触发了本页的写入', lambda r: r.get('crossTriggered') is True),
            ('另一个标签页刚记的进度还在',
             lambda r: r.get('crossCid') == PID_CLICK
             and r.get('crossTitle') == '另一个标签页记的'),
            ('本页自己那次写入也落盘了', lambda r: r.get('crossOwnWrite') is True),
            ('没有 JS 报错',        lambda r: not r['jsErrors']),
        ]),
        (f'/posts/{PID_PROGRESS}?fwtest=landing', '跳转落地 → 自动复位到记录位置', [
            ('落地页认出了章节',       lambda r: r['bars'] == 1),
            ('自动滚到了记录位置',     lambda r: r['scrollY'] > 0),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/books?fwtest=legacy', '文库页 + v1.0 假数据迁移', [
            ('状态小条靠右浮动、和简介同一行',
             lambda r: r['listRows'] >= 1 and '▶' in r['listRowsText']
             and r['listRowsFloat'] == 'right' and r['listRowsWithBrief'] is True),
            # 列表页用短文案（第几章/共几章），不放章节名 —— 名字一长就顶歪简介
            ('列表页用的是短文案',     lambda r: re.search(r'▶\s*\d+/\d+',
                                                      r['listRowsText']) is not None),
            ('标签还是挂在书名后',     lambda r: r['titleBadges'] >= 1
             and '追更中' in r['badgeText']),
            ('那一行里不重复挂进度',   lambda r: '▶' not in r['badgeText']),
            ('显示书签数 🔖2',         lambda r: '🔖2' in r['badgeText']),
            ('两步迁移都跑过了',       lambda r: r['migFlag'] and r['migProgressCleared']),
            ('假章节记录已软删',       lambda r: r['migChapDeleted']),
            ('空壳假书已软删',         lambda r: r['migBookDeleted']),
            ('真书没被误删',           lambda r: r['migRealKept']),
            ('进度搬进了独立的 prog 表',
             lambda r: (r.get('progTable') or {}).get('cid') == PID_PROGRESS),
            ('书记录里不再残留 progress', lambda r: r.get('progLeftInBook') is False),
            ('假进度没被搬进新表（先被清掉了）', lambda r: r.get('progBogusMoved') is False),
            ('假书不再显示 ▶ 进度',    lambda r: '旧版假数据' not in r['listRowsText']
             and '旧版假数据' not in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        (f'/collection/{UID}', '收藏页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('标签挂在书名后',         lambda r: r['titleBadges'] >= 1
             and '列表验证' in r['badgeText']),
            ('页面链接一个都没被挡住', lambda r: not r['blockedLinks']),
            ('子 tab 点得到',          lambda r: r['tabReachable'] is True),
            ('点顶栏入口能打开面板',   lambda r: r['navOpens'] is True),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/', '首页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            # 首页的「推荐」是一行一本的紧凑列表，没有 article 条目可以插行 ——
            # 这种页面就退回把小角标挂在书名后面，不强求另起两行
            ('退回挂在书名后（没有 article 条目）',
             lambda r: r['titleBadges'] >= 1 and '列表验证' in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/channels/1', '频道页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('标签挂在书名后',         lambda r: r['titleBadges'] >= 1
             and '列表验证' in r['badgeText']),
            ('没有 JS 报错',          lambda r: not r['jsErrors']),
        ]),
        ('/thread_index', '主题索引页', [
            ('顶栏入口在、悬浮球没了', lambda r: r['navEntry'] == 1 and r['fabLeft'] == 0),
            ('标签挂在书名后',         lambda r: r['titleBadges'] >= 1
             and '列表验证' in r['badgeText']),
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
            # Chrome 偶尔一个字都不吐，重跑一次，还不行才算真挂
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
                if os.environ.get('FW_DEBUG'):
                    print('     debug:', json.dumps({k:r.get(k) for k in ('crumbProg','listRows','listRowsText','titleBadges','badgeText')}, ensure_ascii=False)[:500])
            print(f'  {"✅" if ok else "❌"} {name}')
        if r['jsErrors']:
            print('   JS 报错：', r['jsErrors'])
        if os.environ.get('FW_CIDS'):
            print('   CIDS:', ','.join(r.get('learnedCids') or []))
        if r.get('learnedTotal') is not None:
            print(f"   学到：章节总数={r.get('learnedTotal')} "
                  f"完结={r.get('learnedDone')} 当前章={r.get('learnedNo')}")
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
