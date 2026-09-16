// ==UserScript==
// @name         废文网 · 结构探测 v0
// @namespace    didi.fw
// @version      0.1.0
// @description  一次性勘查脚本：把当前页面的 DOM 骨架打包成 JSON，用于生成正式版书签脚本的选择器
// @author       小喵
// @match        *://www.xn--pxtr7m5ny.com/*
// @match        *://xn--pxtr7m5ny.com/*
// @run-at       document-idle
// @inject-into  auto
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 工具 ----------

  // 给元素生成一个尽量稳定的 CSS 选择器
  function cssPath(el, maxDepth = 5) {
    const parts = [];
    let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < maxDepth; d++) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift('#' + cur.id);
        break; // id 已经唯一，不用再往上爬
      }
      let seg = cur.tagName.toLowerCase();
      const cls = (cur.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !/^\d/.test(c) && c.length < 30)
        .slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      const sibs = cur.parentElement
        ? [...cur.parentElement.children].filter((s) => s.tagName === cur.tagName)
        : [];
      if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(seg);
      cur = cur.parentElement;
      if (cur === document.body) {
        parts.unshift('body');
        break;
      }
    }
    return parts.join(' > ');
  }

  const clip = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  // ---------- 探测：正文容器候选 ----------
  // 思路：找文字量大、且没有哪个子元素独占了绝大部分文字的元素 —— 那就是「最小正文容器」
  function findTextBlocks() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|HEAD)$/.test(el.tagName)) continue;
      const len = (el.textContent || '').replace(/\s+/g, '').length;
      if (len < 300) continue;
      // 若某个子元素几乎包含了全部文字，说明当前元素只是外壳，跳过
      const hogged = [...el.children].some(
        (c) => (c.textContent || '').replace(/\s+/g, '').length > len * 0.9
      );
      if (hogged) continue;
      out.push({
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        textLen: len,
        pCount: el.querySelectorAll('p').length,
        brCount: el.querySelectorAll('br').length,
        head: clip(el.textContent, 120),
        tail: clip((el.textContent || '').slice(-160), 120),
      });
    }
    return out.sort((a, b) => b.textLen - a.textLen).slice(0, 4);
  }

  // ---------- 探测：链接聚类 ----------
  // 把 href 里的数字换成 N，同一模式的链接归一组 —— 章节目录会形成一个很大的组
  function findLinkGroups() {
    const groups = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (u.host !== location.host) continue;
      const pattern = u.pathname.replace(/\d+/g, 'N') + (u.search ? '?' + u.search.replace(/\d+/g, 'N').slice(1) : '');
      if (!groups.has(pattern)) {
        groups.set(pattern, { pattern, count: 0, samples: [], parentSel: cssPath(a.parentElement || a) });
      }
      const g = groups.get(pattern);
      g.count++;
      if (g.samples.length < 3) {
        g.samples.push({ href: u.pathname + u.search, text: clip(a.textContent, 40) });
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }

  // ---------- 探测：标题候选 ----------
  function findHeadings() {
    return [...document.querySelectorAll('h1,h2,h3,title,.title,#title,[class*=title],[class*=name]')]
      .slice(0, 12)
      .map((el) => ({
        selector: cssPath(el, 4),
        tag: el.tagName.toLowerCase(),
        text: clip(el.textContent, 60),
      }))
      .filter((x) => x.text);
  }

  function collect() {
    return {
      url: location.href,
      title: document.title,
      docTitleMeta: {
        h1: clip(document.querySelector('h1')?.textContent, 60) || null,
        ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
      },
      bodyClass: clip(document.body.className, 80) || null,
      textBlocks: findTextBlocks(),
      linkGroups: findLinkGroups(),
      headings: findHeadings(),
      // 翻页/导航线索
      navHints: [...document.querySelectorAll('a')]
        .filter((a) => /上一[章页]|下一[章页]|目录|返回书页|章节列表/.test(a.textContent))
        .slice(0, 8)
        .map((a) => ({ text: clip(a.textContent, 12), href: a.getAttribute('href'), selector: cssPath(a, 4) })),
    };
  }

  // ---------- 复制（三重降级，兼容 iOS Safari） ----------
  async function copyText(text, btn) {
    const ok = () => {
      btn.textContent = '已复制 ✓';
      setTimeout(() => (btn.textContent = '复制 JSON'), 1500);
    };
    try {
      await navigator.clipboard.writeText(text);
      return ok();
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(0, text.length);
      const done = document.execCommand('copy');
      ta.remove();
      if (done) return ok();
    } catch {}
    btn.textContent = '复制失败，请手动长按选中';
  }

  // ---------- UI（Shadow DOM 隔离，不被网站样式污染） ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
      .fab {
        width: 46px; height: 46px; border-radius: 50%; border: none;
        background: #e8554e; color: #fff; font-size: 20px; line-height: 46px;
        box-shadow: 0 3px 12px rgba(0,0,0,.3); cursor: pointer;
      }
      .panel {
        display: none; position: fixed; inset: 8px; background: #fff; color: #222;
        border-radius: 12px; box-shadow: 0 6px 30px rgba(0,0,0,.4);
        flex-direction: column; overflow: hidden;
      }
      .panel.on { display: flex; }
      .bar { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid #eee; align-items: center; }
      .bar b { font-size: 14px; flex: 1; }
      .bar button {
        padding: 7px 12px; font-size: 13px; border: none; border-radius: 7px;
        background: #e8554e; color: #fff; cursor: pointer;
      }
      .bar button.gray { background: #ddd; color: #333; }
      pre {
        flex: 1; margin: 0; padding: 10px; overflow: auto; font-size: 11px;
        line-height: 1.45; white-space: pre-wrap; word-break: break-all;
        font-family: ui-monospace, Menlo, monospace; -webkit-user-select: text; user-select: text;
      }
    </style>
    <button class="fab" title="结构探测">🔍</button>
    <div class="panel">
      <div class="bar">
        <b>页面结构探测</b>
        <button class="copy">复制 JSON</button>
        <button class="gray close">关闭</button>
      </div>
      <pre></pre>
    </div>
  `;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const pre = $('pre');

  $('.fab').addEventListener('click', () => {
    pre.textContent = JSON.stringify(collect(), null, 1);
    panel.classList.add('on');
  });
  $('.close').addEventListener('click', () => panel.classList.remove('on'));
  $('.copy').addEventListener('click', (e) => copyText(pre.textContent, e.target));
})();
