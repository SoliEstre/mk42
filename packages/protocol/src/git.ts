// 통합 창 «폴더 등록» 칸에 넣은 git 저장소 주소 판별(통합 창 화면)·검증(데몬 folders.clone). 브라우저에서도 써요(Node 의존 없음).

export interface CloneUrl {
  /** 다듬은 주소(앞뒤 공백·감싼 따옴표 제거) — git clone에 이대로 넘겨요 */
  url: string;
  /** 클론할 폴더 이름(VS Code·git처럼 마지막 경로 조각, 끝의 .git 뺌) */
  name: string;
}

/** Windows 폴더 이름에 못 쓰는 글자와 제어 문자 */
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * git 저장소 주소면 {url, name}, 아니면 null.
 * 받는 모양: `https://` `http://` `ssh://` `git://` 주소(경로가 있어야 해요), scp 모양 `user@host:path`.
 * 막는 것: 공백·제어 문자, `-`로 시작(옵션 주입), `ext::`·`file://` 같은 다른 전송, 주소 안의 비밀번호·토큰(`user:pass@` — 로그·기록에
 * 남지 않게, AGENTS.md §5.11), 폴더 이름을 만들 수 없는 주소.
 */
export function parseCloneUrl(text: string): CloneUrl | null {
  const url = text.trim().replace(/^"(.*)"$/, '$1').trim();
  if (!url || url.length > 2048 || url.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(url)) return null;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    if (!['https', 'http', 'ssh', 'git'].includes(scheme[1]!.toLowerCase())) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!u.hostname || u.password) return null;
    if ((scheme[1]!.toLowerCase() === 'https' || scheme[1]!.toLowerCase() === 'http') && u.username) return null; // 토큰을 사용자 이름에 넣는 경우
    if (u.search || u.hash) return null;
    path = u.pathname;
  } else {
    // scp 모양: [user@]host:path — 드라이브 문자(C:\…)·UNC와 헷갈리지 않게 호스트는 두 글자 이상이고 `@`가 있어야 해요
    const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]{2,}):(?!\/\/)(.+)$/.exec(url);
    if (!scp) return null;
    path = scp[3]!;
  }
  const last = path.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  if (!name || name === '.' || name === '..' || name.length > 200 || BAD_NAME.test(name) || RESERVED_NAME.test(name) || /[. ]$/.test(name)) return null;
  return { url, name };
}

/** 로그용: 주소에서 사용자 이름을 지운 모양(비밀번호가 든 주소는 parseCloneUrl이 이미 막아요) */
export function redactCloneUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}
