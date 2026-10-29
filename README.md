# DupNest

[![npm beta version](https://img.shields.io/npm/v/dupnest/beta)](https://www.npmjs.com/package/dupnest)

**Public beta · Linux only · Node.js 24+**

A CLI to find duplicate files, organize folders, and clean supported developer caches.

## Install and run

```bash
npm install --global dupnest@beta
dupnest --help
dupnest scan ~/Downloads
```

File cleanup requires `gio` and working desktop Trash support. On Ubuntu or Debian, install `gio` with:

```bash
sudo apt install libglib2.0-bin
```

## Commands

| Command | What it does |
| --- | --- |
| `dupnest scan [path]` | Find identical files and possible numbered versions, such as `report (1).pdf`. |
| `dupnest clean [path]` | Choose which files to keep and move unwanted copies to Trash. |
| `dupnest organize [path]` | Group top-level files into category folders after confirmation. |
| `dupnest tidy [path]` | Review duplicates, then organize the remaining top-level files. |
| `dupnest dev scan` | Show supported cleanup actions and storage that will be retained. |
| `dupnest dev clean` | Select developer cleanup actions, review their commands, and confirm. |
| `dupnest --help` | Show usage and options. |
| `dupnest --version` | Show the installed version. |

File commands default to `~/Downloads`. Quote paths that contain spaces.

```bash
dupnest scan "~/Documents/Annual reports" --recursive --verbose
dupnest clean ~/Downloads --dry-run
dupnest clean ~/Downloads
dupnest organize ~/Downloads --dry-run
dupnest organize ~/Downloads
dupnest tidy ~/Downloads --recursive
```

## Options

| Option | Effect |
| --- | --- |
| `--recursive` | Include nested folders in file scanning and duplicate review. Organization always stays top-level. |
| `--dry-run` | Preview without moving files or executing cleanup commands. |
| `--verbose` | Show matching files, individual moves, the full developer storage inventory, and tool logs. |
| `--` | End options before a path beginning with `-`. |

`--recursive` applies only to file commands. All six main commands support `--dry-run` and `--verbose`.

## File cleanup and organization

During duplicate review, select a file number to keep it, `a` to keep all, or `s`/Enter to skip. You can optionally rename the retained file. Different file contents require your selection; timestamps only provide a suggestion.

Organization shows category counts and destination folders, then asks for confirmation. Existing filenames get numbered suffixes to avoid overwriting. Nested directories and existing category contents stay in place.

| Folder | File types |
| --- | --- |
| Documents | PDF, Office documents, text, CSV, RTF |
| Images | JPG, PNG, GIF, WebP, SVG, BMP |
| Videos | MP4, MKV, MOV, AVI, WebM |
| Audio | MP3, WAV, OGG, FLAC, M4A |
| Archives | ZIP, RAR, 7Z, TAR, GZ, TGZ |
| Installers | DEB, AppImage, RPM |
| Others | Other extensions and extensionless files |

Changes require an interactive terminal and explicit approval. Enter defaults to No. Symlinks and incomplete downloads are skipped. File cleanup uses Trash; disk space is freed only when you empty Trash separately.

## Developer cleanup

```bash
dupnest dev scan
dupnest dev clean --dry-run
dupnest dev clean
dupnest dev scan --verbose
```

Supported actions:

- **npm:** verify and garbage-collect cache entries, or clear package cache contents with extra confirmation. Verification keeps valid packages.
- **Go:** clear the build cache. Future builds must rebuild it.
- **Docker:** prune dangling images, dangling build cache, or stopped containers. Container cleanup requires extra confirmation.

Enter comma-separated menu numbers, review the selected commands, and confirm. Options depend on the current scan. Developer cleanup can be irreversible and may require future downloads or rebuilds.

**Cache usage is not expected savings.** Tagged Docker images are retained. Docker volumes, Go modules, Gradle, pnpm, and Yarn are scan-only. Retained storage is listed separately from supported actions.

Default inspection measures npm and Go build caches. `--verbose` also measures scan-only caches when paths are available, so it can take longer. To inspect configured pnpm, Yarn, or Gradle locations:

```bash
DUPNEST_PNPM_STORE_PATH=/absolute/store dupnest dev scan --verbose
DUPNEST_YARN_CACHE_PATH=/absolute/cache dupnest dev scan --verbose
GRADLE_USER_HOME=/absolute/gradle-home dupnest dev scan --verbose
```

## Development

Clone the source and run it directly:

```bash
git clone https://github.com/cric2000/dup-nest.git
cd dup-nest
node bin/dupnest.js --help
node bin/dupnest.js scan ~/Downloads
```

To install your checkout globally, run `npm install --global .` from the project directory.

Run the development checks from the checkout:

```bash
npm test          # Run tests
npm run check    # Check JavaScript syntax
npm run verify   # Test, pack, and smoke-test a temporary installation
```

The verification command cleans up its temporary package and installation. It does not clear workstation caches or prune Docker.

## License

[MIT](https://github.com/cric2000/dup-nest/blob/main/LICENSE).
