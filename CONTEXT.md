# CONTEXT — Creator Gallery (aprendizados)

Lições e armadilhas resolvidas durante o desenvolvimento. Leia antes de mexer no backend.

## Ambiente / build

- **`cargo build` não detecta edições** (o editor preserva o mtime). Ele mostra `Finished 0.3s` sem recompilar e roda um binário antigo. **Antes de compilar, force o mtime:**
  ```powershell
  Get-ChildItem src\*.rs | ForEach-Object { $_.LastWriteTime = Get-Date }; cargo build
  ```
  Mudar o `Cargo.toml` ou `tauri.conf.json`/`capabilities` força recompilação de verdade. `cargo check` costuma pegar as mudanças, mas o **link do binário** não.
- **`LNK1103` (depuração corrompida):** artefato de build incremental quebrado (geralmente após atualização da toolchain MSVC). Conserto: `cargo clean` + rebuild.
- Rodar o app: `npm run tauri dev`. Sempre liberar a porta **1420** antes (matar `creator-gallery` + o `node` que segura a 1420).

## yt-dlp: progresso bufferizado (o problema mais difícil)

- O `yt-dlp.exe` (PyInstaller) faz **block-buffering do stdout** quando é um pipe. O progresso (`--progress-template`) e o `--print [DONE]` **só chegam no fim** → barra travada em 0% e galeria atualizando só no final.
- `PYTHONUNBUFFERED=1` **não funciona** (o exe congelado ignora). `--quiet --progress` também não move o progresso pro stderr.
- **ConPTY via `portable-pty` DEU DEADLOCK** com este exe (trava até o `--version`). **Abandonado.**
- **Solução adotada:** ler stdout/stderr por pipes normais (sem travar) E calcular o progresso por **polling do sistema de arquivos** (a cada 400 ms): conta arquivos finais novos no disco e mede o `.part` atual. Cada arquivo final vira um item da galeria na hora.
- Ao varrer o disco, **ignore arquivos intermediários**: `Titulo.f137.mp4`, `Titulo.temp.mp4` e os formatos de áudio durante o merge. Conte só a extensão final (`mp4`/`mp3`).
- Barra de progresso é **por vídeo** (`_percent_str` reseta por formato; use o **máximo** p/ não recuar no merge vídeo→áudio; reinicia quando o nº de concluídos avança).

## Cookies / login walls

- **YouTube exige cookies** a partir deste IP ("Sign in to confirm you're not a bot"). Instagram também. **Facebook público funciona** sem cookies.
- **Chrome/Edge não dão pra ler:** aberto → DB travado (issue #7271); fechado → **App-Bound Encryption (Chrome 127+)** cifra os cookies com chave do próprio Chrome. Nem fechado o yt-dlp lê.
- **Caminhos que funcionam:** arquivo **`cookies.txt`** (extensão "Get cookies.txt LOCALLY") via `--cookies`, OU **Firefox** logado (o yt-dlp lê mesmo aberto). UI já suporta os dois (`cookies_browser` / `cookies_file` em settings).
- Erros do yt-dlp podem sair no **stdout OU stderr** — capture erros (linhas com "error") dos **dois** streams, senão a mensagem vem vazia/genérica.

## Outras armadilhas

- **Abrir arquivo:** o plugin `opener` do Tauri bloqueia `open-path` fora de um escopo. Como os downloads vão pra pastas arbitrárias, **não use o plugin** — use comandos Rust nativos (`open_path`/`reveal_path` com a crate `open` + `explorer /select,`).
- **Seletor de formato** das qualidades 1080/720/480 PRECISA de fallback final: `bv*[height<=q]+ba/b[height<=q]/bv*+ba/b`. Sem ele, FB/IG/X/TikTok davam "Requested format is not available" (formatos sem `height`).
- **Estrutura de pastas:** `<destino>/<rede>/<NomePlaylist>/arquivo` (playlist) ou `<destino>/<rede>/videos/arquivo` (avulso). Rede em minúsculo.
- **Pausar/continuar:** pausar = matar o yt-dlp mantendo os `.part`; continuar = re-rodar `download_video` com o MESMO request (o yt-dlp pula o que já existe e retoma o parcial).
- **Corte (vídeo existente):** ffmpeg com `-ss <início> -t <duração> -i input -c:v libx264 ... -c:a aac` (parse o tempo p/ segundos e calcule a duração — evita ambiguidade do `-to` como opção de input). No download, yt-dlp usa `--download-sections "*início-fim" --force-keyframes-at-cuts`.
- **shadcn é real** (Tailwind v4 + Radix + componentes em `src/components/ui/`), não CSS imitando. Janela sem moldura (`decorations:false`) + titlebar própria (precisa das permissões `core:window:*` no capabilities).

## Binários

- O app usa **sidecars**: `src-tauri/binaries/{yt-dlp,ffmpeg}-x86_64-pc-windows-msvc.exe`, copiados p/ `target/debug/` no dev. O resolvedor procura: pasta do exe (sidecar) → PATH → winget → nome puro.
