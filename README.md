[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/krococoro/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/krococoro/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — satu patch tool untuk semua format edit AI

`mend` menerapkan edit yang ditulis AI ke pohon file teks, mengikuti
[SPEC.md](SPEC.md) (v1). Satu perintah, empat format patch: unified diff
(nomor baris boleh salah), blok SEARCH/REPLACE, V4A, dan JSON tool calls.
Setiap edit dicari pada tier pencocokan pertama yang berhasil (persis,
tanpa spasi/tab di akhir, tanpa spasi/tab di kedua ujung), dan semua
perubahan ditulis — atau tidak ada sama sekali bila ada satu edit yang
gagal.

Kompetisi: [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
(`hidden-spec-cli-01-run-20261122`).

## Cara kerja

- `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH dari
  file atau stdin (`-` / tanpa argumen). `--check` tidak menulis apa pun,
  `--strict` hanya memakai tier 0.
- Parser per format membaca seluruh patch dulu (kesalahan parse dilaporkan
  sebelum file apa pun dilihat), lalu edit diterapkan berurutan ke salinan
  pohon di memori; edit yang gagal tidak mengubah apa pun dan edit
  sesudahnya tetap berjalan. Bila ada yang gagal, tidak ada file yang
  ditulis (exit 1); bila semua berhasil, semua perubahan ditulis (exit 0).
- Unified diff: section (`diff --git` atau pasangan `---`/`+++`), hunk
  dengan offset `d` dan pencocokan posisi terdekat ke `A - 1 + d`,
  pembuatan/penghapusan/pemindahan file, dan penanganan
  `\ No newline at end of file`. Pemindahan yang berhasil dilaporkan
  sebagai `R <lama> -> <baru>`.
- SEARCH/REPLACE: path dari baris terdekat sebelum `<<<<<<< SEARCH`
  (baris pagar ```` ``` ```` dilewati); bila tidak ada, memakai path blok
  sebelumnya. Old kosong berarti membuat file; old yang muncul lebih dari
  sekali berarti `ambiguous`.
- V4A: section Add/Delete/Update dengan kursor yang bergerak maju,
  anchor `@@`, dan chunk `*** End of File` yang terikat ke akhir file.
- JSON: satu array edit atau JSON Lines (`create`, `str_replace`,
  `insert`); file CRLF dinormalisasi ke LF untuk pencocokan dan ditulis
  kembali sebagai CRLF.
- Jalur tidak aman (`/`, `\`, segmen kosong/`.`/`..`) ditolak sebelum
  pemeriksaan lain. Tidak ada jam dinding, tidak ada angka acak, tidak
  ada jaringan — hasilnya deterministis.

## Hasil practice

Diperiksa dengan `node check.ts <practice.json>` dari kit (100 cek:
30 unified, 20 search-replace, 20 v4a, 15 json, 15 cli):

- **mend: 100 dari 100 lolos — skor practice 1000.**
- Starter (strict applier, house baseline): 24 dari 100 — skor 240.

Ditambah 56 kasus tepi buatan sendiri dari kalimat-kalimat SPEC.md yang
tidak ditunjukkan practice set (parse error, pemindahan berantai,
file CRLF tanpa newline akhir, path tidak aman, `--check`, `--strict`):
56 dari 56 lolos.

## File

- `main.ts` — CLI (Node 22, stdlib saja).
- `runner.ts` — runner kit (tidak diubah), dipakai saat trial.
- `check.ts` — pemeriksa practice set dari kit (tidak diubah).
- `SPEC.md` — spesifikasi.
- `LICENSE` — MIT.
