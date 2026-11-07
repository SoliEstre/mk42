// D41 호환: 옛 번들 이름 dist/m42d.mjs를 새 번들 dist/mk42d.mjs를 부르는 한 줄짜리 shim으로 덮어써요.
// 옛 로그온 작업(Mark42\m42d)이 아직 m42d.mjs를 실행해도 지금 코드가 돌아서, 그 데몬이 작업을 새 이름으로 옮겨요.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
writeFileSync(
  join(dist, 'm42d.mjs'),
  "// D41 호환 shim — 옛 로그온 작업(Mark42\\m42d)이 실행하는 옛 번들 이름이에요. 새 번들을 불러요(npm run build가 만들어요).\nimport './mk42d.mjs';\n",
);
