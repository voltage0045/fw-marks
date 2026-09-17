#!/usr/bin/env python3
"""
坚果云 WebDAV 自查工具。

同步报错只给得出一个 HTTP 状态码，看不出到底哪儿不对。这个脚本把该问的都问一遍：
  1. 列出你账号下**真实存在**的顶层同步文件夹（地址写错文件夹名是最常见的原因）
  2. 试着读一次目标文件
  3. 征得同意后，写一个**另取名字**的测试文件再删掉，验证写权限

密码用 getpass 读：不回显、不作为命令行参数、不写进任何文件 ——
所以它不会出现在 shell 历史或会话记录里。脚本本身也不保存任何凭据。

跑法：  python3 test/dav-check.py
"""

import base64
import getpass
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DAV_ROOT = 'https://dav.jianguoyun.com/dav/'


def enc(url):
    """路径里的非 ASCII（比如中文文件夹名）要先 percent-encode，
    否则 urllib 连请求都发不出去，看起来就像「连不上」。"""
    p = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((
        p.scheme, p.netloc,
        urllib.parse.quote(p.path, safe='/'),
        p.query, p.fragment))


def req(method, url, user, pw, body=None, headers=None):
    """发一个请求，只回 (状态码, 正文)，不抛异常。"""
    r = urllib.request.Request(enc(url), data=body, method=method)
    token = base64.b64encode(f'{user}:{pw}'.encode()).decode()
    r.add_header('Authorization', 'Basic ' + token)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:                      # 网络层面的问题
        return 0, f'{type(e).__name__}: {e}'


def explain(code):
    return {
        0:   '连不上（网络/代理问题）',
        401: '账号或密码不对 —— 要用「应用密码」，不是登录密码',
        403: '认证过了但没权限：文件夹只读？或者账号流量超限？',
        404: '路径不存在',
        405: '方法不被允许（这个路径可能是目录不是文件）',
        409: '上级文件夹不存在',
        423: '文件被锁定',
        507: '空间满了',
    }.get(code, '')


def main():
    print('坚果云 WebDAV 自查\n' + '=' * 40)
    print('密码不会回显、不会被保存，也不会进 shell 历史。\n')

    user = input('坚果云账号（注册邮箱）: ').strip()
    if not user:
        print('× 没输账号'); return 1
    pw = getpass.getpass('应用密码（第三方应用管理里生成的，不是登录密码）: ').strip()
    if not pw:
        print('× 没输密码'); return 1

    # ---- 1. 列出真实存在的顶层同步文件夹 ----
    print('\n[1/3] 列出你账号下的顶层同步文件夹…')
    code, body = req('PROPFIND', DAV_ROOT, user, pw,
                     headers={'Depth': '1', 'Content-Type': 'application/xml'})
    print(f'  PROPFIND / → {code} {explain(code)}')
    folders = []
    if code in (207, 200):
        for href in re.findall(r'<[^>]*href>(.*?)</[^>]*href>', body, re.I):
            name = urllib.parse.unquote(href).rstrip('/').split('/')[-1]
            if name and name != 'dav':
                folders.append(name)
        folders = list(dict.fromkeys(folders))
        if folders:
            print('  你的同步文件夹（地址里必须用下面其中一个，一字不差）：')
            for f in folders:
                print(f'    · {f}')
            print('\n  → 地址应该长这样：')
            print(f'    https://dav.jianguoyun.com/dav/{folders[0]}/fw-marks.json')
        else:
            print('  ⚠️ 一个同步文件夹都没列出来 —— 去坚果云里先建一个')
    elif code == 401:
        print('  → 密码就是这一步错的，后面不用看了')
        return 1

    if not folders:
        return 1

    # ---- 2. 读一次目标文件 ----
    target = input(f'\n[2/3] 要检查的完整地址（直接回车用 …/{folders[0]}/fw-marks.json）: ').strip()
    target = target or f'{DAV_ROOT}{folders[0]}/fw-marks.json'
    code, body = req('GET', target, user, pw)
    print(f'  GET  → {code} {explain(code)}'
          + ('   （404 = 文件还没建，正常）' if code == 404 else ''))

    # ---- 3. 写权限（换个名字，别碰真数据）----
    folder = target.rsplit('/', 1)[0]
    probe = folder + '/fw-marks-selftest.json'
    ans = input(f'\n[3/3] 试写一个测试文件再删掉？不会碰你的真数据\n'
                f'      {probe}\n      [y/N]: ').strip().lower()
    if ans != 'y':
        print('  跳过'); return 0

    code, body = req('PUT', probe, user, pw, body=b'{"selftest":true}',
                     headers={'Content-Type': 'application/json'})
    print(f'  PUT  → {code} {explain(code)}')
    ex = re.search(r'<s:exception>(.*?)</s:exception>', body or '')
    msg = re.search(r'<s:message>(.*?)</s:message>', body or '')
    if ex:
        print(f'  ⚠️ 服务器自报的原因：{ex.group(1)}'
              + (f' —— {msg.group(1)}' if msg else ''))
        if ex.group(1) == 'AccountExpired':
            print('     → 坚果云账户已过期，去续期；或者先只用 GitHub 私有仓库那一路')
    elif code >= 300 and body:
        print('  服务器说：', re.sub(r'\s+', ' ', body)[:200])
    if code == 0:
        print('\n× 请求根本没发出去（不是服务器拒绝）。检查网络/代理，'
              '或者地址里有没有打错字。')
        print('  详情：', body)
        return 1
    if code < 300:
        dcode, _ = req('DELETE', probe, user, pw)
        print(f'  清理 DELETE → {dcode}')
        print('\n✅ 写权限没问题。那同步失败多半是地址里的文件夹名不对，'
              '照第 1 步列出来的名字改一下。')
    else:
        print('\n× 写不进去。常见原因：这个文件夹是别人共享给你的只读文件夹，'
              '或者免费账户当月上传流量用完了（坚果云免费版每月 500MB 上传）。')
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
