![Banner](Images/banner.png?)

# EeveeSpotifyReincarnated

**Maintainers:** [jaydenjcpy](https://github.com/jaydenjcpy) & [faroukbmiled](https://github.com/faroukbmiled) & [Mod4](https://github.com/M0d-4) <br />
**Last Update:** `6/15/26` **Spotify Version:** `9.1.56`

This tweak makes Spotify think you have a Premium subscription, granting free listening, just like Spotilife, and provides some additional features like custom lyrics.

> [!NOTE]
> The original EeveeSpotify repository was disabled due to a [DMCA takedown](https://github.com/github/dmca/blob/master/2025/08/2025-08-14-spotify.md). This repository will not contain IPA packages in the repo itself.

## Custom Lyrics Support

**Spotify 9.1.56 and above** - Full custom lyrics functionality is available with the following providers:

- **Musixmatch**
- **PetitLyrics**
- **LRCLIB**
- **Genius**

> [!NOTE]
> All providers work now

## How to build an EeveeSpotify IPA using Github actions
> [!NOTE]
> If this your first time, complete following steps before starting:
>
> 1. Fork this repository using the fork button on the top right
> 2. On your forked repository, go to **Repository Settings** > **Actions**, enable **Read and Write** permissions.

<details>
  <summary>How to build the EeveeSpotify IPA</summary>
  <ol>
    <li>Click on <strong>Sync fork</strong>, and if your branch is out-of-date, click on <strong>Update branch</strong>.</li>
    <li>Navigate to the <strong>Actions tab</strong> in your forked repository and select <strong>Create IPA Packages</strong> if you're on desktop/widescreen. Tap on <strong>All Workflows</strong> and select <strong>Create IPA Packages</strong> if you're on mobile/portrait.</li>
    <li>Click the <strong>Run workflow</strong> button located on the right side.</li>
    <li>Prepare a decrypted .ipa file <em>(we cannot provide this due to legal reasons)</em>, then upload it to a file provider (e.g., filebin.net, filemail.com, or Dropbox is recommended). Paste the URL of the decrypted IPA file in the provided field.</li>
    <li><strong>NOTE:</strong> Make sure to provide a direct download link to the file, not a link to a webpage. Otherwise, the process will fail.</li>
    <li>Go to the releases page of the EeveeSpotify repository (<strong>NOT</strong> the fork). Hold and copy the link of the .deb file, which corresponds to your phone's architecture.</li>
    <li>Make sure all inputs are correct, then click <strong>Run workflow</strong> to start the process.</li>
    <li>Wait for the build to finish. You can download the EeveeSpotify IPA from the releases section of your forked repo. (If you can't find the releases section, go to your forked repo and add /releases to the URL, i.e., github.com/user/EeveeSpotifyReborn/releases.)</li>
  </ol>
</details>

## Build the Share Editor rootless package

The `Build Share Editor rootless package` workflow builds the current branch on a
`macos-15` runner with Xcode 16.2, compiles the renamed `EeveeSwiftProtobuf`
framework, and produces a rootless `.deb` plus a TrollFools-compatible ZIP. The
workflow also unpacks the package before uploading it and verifies the Eevee
dylib, framework, `ShareEditor`, and `TimelineEditor` resources are present.

1. Push the public source changes to a branch in your fork. The workflow file
   `.github/workflows/build-share-editor.yml` must also exist on the fork's
   default branch before GitHub exposes its `workflow_dispatch` form; merge or
   copy the workflow there first, then use `ref` for the source branch.
2. Run **Actions → Build Share Editor rootless package** and set `ref` to that branch.
   After the workflow exists on the default branch, the CLI equivalent for the
   example branch is
   `gh workflow run build-share-editor.yml --repo OWNER/FORK --ref share-editor-work -f ref=share-editor-work`.
   The CLI `--ref` selects the workflow definition, while `-f ref=...` supplies
   the source ref checked out by this workflow.
3. Leave `ipa_url` empty to build the package artifacts without uploading or
   modifying an IPA. The workflow publishes these independent artifacts:
   - `eevee-share-editor-rootless-deb` contains the rootless `.deb` and build metadata.
   - `eevee-share-editor-trollfools-zip` contains a ZIP whose top level is exactly
     `EeveeSpotify.dylib`, `EeveeSwiftProtobuf.framework`, and
     `EeveeSpotify.bundle`.
4. For TrollFools v4.3, download the `eevee-share-editor-trollfools-zip`
   Actions artifact and extract that outer artifact archive first. Import the
   contained `EeveeSpotify-share-editor-trollfools.zip` into TrollFools, not the
   outer ZIP downloaded from GitHub Actions. Do not give TrollFools the `.deb`:
   its `.deb` extractor only selects dylib/bundle payloads and omits
   `EeveeSwiftProtobuf.framework`, while its ZIP preprocessing accepts `.dylib`,
   `.framework`, and `.bundle` together.
5. To build a complete IPA instead, download the `.deb`, then splice it into a
   locally held IPA without modifying the original:

   ```sh
   Tools/splice-deb-into-ipa.sh \
     /path/to/Spotify-9.1.60-debug.ipa \
     /path/to/com.eevee.spotify_6.6.6_iphoneos-arm64.deb \
     /path/to/Spotify-9.1.60-share-editor.ipa
   ```

   The script validates all three Eevee payloads, preserves the original main
   executable entitlements, signs the replacement Mach-O files with `ldid`, and
   runs `zip -T`. It builds in a same-directory temporary path and atomically
   replaces the requested output only after all checks pass, so a failed splice
   preserves any existing output IPA. This is a TrollStore/AppSync ad-hoc splice;
   ordinary certificate sideloaders must re-sign the complete app bundle. The
   Spotify IPA is never needed by the default Actions job.

The optional splice job accepts an external direct-download `ipa_url` only when
it is an absolute HTTPS URL without embedded credentials and the matching
`ipa_sha256` (64 hexadecimal characters) is supplied. The IPA stays
in the runner's temporary directory and is uploaded only as the short-lived
`eevee-share-editor-ipa` artifact; it must not be committed to this repository.
Do not put credentials in the URL. No repository secret is required for the
`.deb` job. Workflow inputs are stored with the run and are not secret fields, so
do not place access tokens in the URL or its query string; use a local build or an
independently secured download channel for a private IPA source.

## The History

In January 2024, Spotilife, the only tweak to get Spotify Premium, stopped working on new Spotify versions. [whoeevee](https://github.com/whoeevee) decompiled Spotilife, reverse-engineered Spotify, intercepted requests, etc., and created this tweak.

In December 2025, whoeevee, the maintainer of the EeveeSpotify tweak at the time, announced he'll be discontinuing the tweak because of the burden of keeping up with Spotify's constantly changing architectures. Soon after, [Meep1](https://github.com/Meeep1), forks the original Eevee repo and continues to develop the tweak to support newer Spotify versions, under the project name EeveeSpotiyRevivedPublic.

In  March 2026, the latest EeveeSpotifyRevivedPublic release, v9.1.28, users experienced constant logging out issues and reported to Skye, however, at the time of this README.md written, EeveeSpotifyRevivedPublic hasn't released any newer updates. During March, I've been constantly annoyed by the logout issue and decided to take matters into my own hands and forked EeveeSpotifyRevivedPublic and fixed the logout issue, which will eventually lead to the creation of this repository, which will be continuing the legacy of EeveeSpotify for newer versions of Spotify.



## Restrictions

Please refrain from opening issues about the following features, as they are server-sided and will **NEVER** work:

- Very High audio quality
- Native playlist downloading (you can download podcast episodes though)
- Jam (hosting a Spotify Jam and joining it remotely requires Premium; only joining in-person works)
- AI DJ/Playlist
- Spotify Connect (When using Spotify Connect, the device will act as a remote control and stream directly to the connected device. This is a server-sided limitation and is beyond the control of EeveeSpotify, so it will behave as if you have a Free subscription while using this feature.)

## [Common Issues](https://github.com/jaydenjcpy/EeveeSpotifyReincarnated/blob/Master/common_issues.md)
Please check out the hyperlink above before opening an issue


## Lyrics Support

EeveeSpotify replaces Spotify monthly limited lyrics with one of the following four lyrics providers:

- Genius: Offers the best quality lyrics, provides the most songs, and updates lyrics the fastest. Does not and will never be time-synced.

- LRCLIB: The most open service, offering time-synced lyrics. However, it lacks lyrics for many songs.

- Musixmatch: The service Spotify uses. Provides time-synced lyrics for many songs, but you'll need a user token to use this source. To obtain the token, download Musixmatch from the App Store, sign up, then go to Settings > Get help > Copy debug info, and paste it into EeveeSpotify alert. You can also extract the token using MITM.

- PetitLyrics: Offers plenty of time-synced Japanese and some international lyrics.

If the tweak is unable to find a song or process the lyrics, you'll see a "Couldn't load the lyrics for this song" message. The lyrics might be wrong for some songs when using Genius due to how the tweak searches songs. While I've made it work in most cases, kindly refrain from opening issues about it.

## How It Works

EeveeSpotify intercepts Spotify requests to load user data, deserializes it, and modifies the parameters in real-time. This method works incredibly stable across supported Spotify versions.

The tweak also sets `trackRowsEnabled` to `true`, allowing you to see track rows and liked tracks on artist pages just like with Premium.

## Installation

For sideloaded IPAs, we recommend using **SideStore** or certificate-based signing tools like **Ksign** for best compatibility.

To open Spotify links in sideloaded app, use [OpenSpotifySafariExtension](https://github.com/BillyCurtis/OpenSpotifySafariExtension). Remember to activate it and allow access in Settings > Safari > Extensions.

## Credits
Thanks for all of the community's support, also, thanks to all the devs who worked along with me to revive this project Go check the other dev's out:

[Ryuk](https://github.com/faroukbmiled) 

[Mod4](https://github.com/M0d-4)

[estrogencat](https://github.com/estrogencat)

[Skye](https://github.com/Meeep1) 

[whoeevee](https://github.com/whoeevee) 

## Star History

<a href="https://www.star-history.com/?repos=jaydenjcpy%2FEeveeSpotifyReincarnated&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jaydenjcpy/EeveeSpotifyReincarnated&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jaydenjcpy/EeveeSpotifyReincarnated&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jaydenjcpy/EeveeSpotifyReincarnated&type=date&legend=top-left" />
 </picture>
</a>
