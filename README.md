# PowerSocial — Creator Gallery

App desktop (Tauri + React + TypeScript) para baixar e editar vídeos/áudios do
YouTube, Instagram, Facebook e X, com uma galeria local organizada.

## Recursos

- **Download** via `yt-dlp` + `ffmpeg`: vídeo único ou playlist (baixar tudo,
  escolher vídeos, ou só este vídeo), com escolha de qualidade (até a máxima ou
  só áudio em MP3).
- **Prévia de tamanho** por item da playlist antes de baixar (estimativa paralela).
- **Fila** com progresso ao vivo, **pausar/continuar** e **cancelar**.
- **Organização** automática por rede social e nome da playlist:
  `destino/youtube/Nome da Playlist/...`.
- **Cookies** (navegador ou arquivo `cookies.txt`) para conteúdo que exige login.
- **Galeria** com favoritos, filtros por rede, busca, ordenação (data/nome/
  tamanho/duração) e importação de uma pasta existente.
- **Editor de vídeo** não-destrutivo: timeline com zoom/miniaturas/atalhos,
  corte (com *smart cut* sem re-encode), recorte (crop), girar/espelhar,
  velocidade, volume/fade, extrair áudio, capturar quadro e exportar GIF —
  com render em segundo plano e desfazer/refazer.
- Interface em **shadcn/ui** (Tailwind v4 + Radix), tema escuro, janela com
  titlebar customizada.

## Rodando em desenvolvimento

Pré-requisitos: Node.js, Rust (toolchain MSVC no Windows) e o Tauri CLI.

```bash
npm install
npm run tauri dev
```

### Binários sidecar (yt-dlp / ffmpeg)

Os executáveis do `yt-dlp` e do `ffmpeg` ficam em `src-tauri/binaries/` e são
versionados via **Git LFS** (o ffmpeg passa de 100 MB). Em outro PC, basta ter o
[Git LFS](https://git-lfs.com/) instalado — ao clonar, os binários vêm junto:

```bash
git lfs install
git clone https://github.com/nonat0/PowerSocial.git
```

Se os binários vierem como "ponteiros" (Git LFS não estava instalado no clone):

```bash
git lfs pull
```

O resolvedor procura nesta ordem: pasta do executável (sidecar) → PATH → winget.

## Build

```bash
npm run tauri build
```

O instalador sai em `src-tauri/target/release/bundle/`.

## Estrutura

```
src/                   Frontend React (TypeScript)
  App.tsx              Tela principal (link → preview → download → galeria)
  api.ts               Ponte com o backend (invoke + eventos)
  components/          UI: GalleryCard, JobsPanel, VideoEditor, ui/ (shadcn)
src-tauri/src/         Backend Rust (Tauri)
  lib.rs               Registro de comandos e plugins
  downloader.rs        Download (yt-dlp), edição (ffmpeg), progresso, sondas
  history.rs           Persistência (histórico, configurações, cancelados)
```

## Aviso

Baixe apenas conteúdo próprio ou com autorização. Respeite os direitos autorais
e os termos de uso de cada plataforma.
