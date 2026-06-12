import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("mobile app shell exists as a separate PWA build target", async () => {
  const files = [
    "app/mobile/index.html",
    "app/mobile/manifest.webmanifest",
    "app/mobile/public/manifest.webmanifest",
    "app/mobile/public/icon.svg",
    "app/mobile/public/mobile-sw.js",
    "app/mobile/vite.config.mjs",
    "app/mobile/src/main.jsx",
    "app/mobile/src/styles.css",
  ];

  for (const file of files) {
    const stat = await fs.stat(file);
    assert.equal(stat.isFile(), true, `${file} should be a file`);
  }

  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["build:mobile"],
    "vite build --config app/mobile/vite.config.mjs",
  );
});

test("mobile app is installable and keeps realtime APIs out of offline cache", async () => {
  const html = await read("app/mobile/index.html");
  const manifest = JSON.parse(await read("app/mobile/manifest.webmanifest"));
  const publicManifest = JSON.parse(await read("app/mobile/public/manifest.webmanifest"));
  const source = await read("app/mobile/src/main.jsx");
  const serviceWorker = await read("app/mobile/public/mobile-sw.js");
  const viteConfig = await read("app/mobile/vite.config.mjs");

  assert.equal(manifest.name, "codex-loop 移动监控");
  assert.deepEqual(publicManifest, manifest);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "zh-CN");
  assert.equal(manifest.start_url, "/mobile-app");
  assert.equal(manifest.scope, "/mobile-app/");
  assert.equal(manifest.icons.some((icon) => icon.src === "/mobile-app/icon.svg"), true);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /codex-loop 移动监控/);
  assert.match(html, /\/mobile-app\/manifest\.webmanifest/);
  assert.match(viteConfig, /base:\s*"\/mobile-app\/"/);
  assert.match(source, /registerMobileServiceWorker/);
  assert.match(source, /navigator\.serviceWorker\.register\("\/mobile-app\/mobile-sw\.js"\)/);
  assert.match(source, /REQUEST_TIMEOUT_MS = 8000/);
  assert.match(serviceWorker, /CACHE_NAME/);
  assert.match(serviceWorker, /SHELL_URLS/);
  assert.doesNotMatch(serviceWorker, /"\/manifest\.webmanifest"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
});

test("mobile app surfaces timeout and degraded polling states without clearing the last good snapshot", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /AbortController/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /连接超时，请确认 codex-loop 服务仍在运行/);
  assert.match(source, /lastSuccessAtRef/);
  assert.match(source, /hasLastSnapshotRef/);
  assert.match(source, /setStatusText\(hasLastSnapshotRef\.current \? "连接波动" : "连接失效"\)/);
  assert.match(source, /暂时连不上服务，先显示 .* 的最近结果/);
  assert.match(source, /暂时还没连上 codex-loop 服务/);
});

test("mobile app slows polling and exposes a retry action after connection degradation", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /DEGRADED_POLL_MS = 20000/);
  assert.match(source, /FAST_POLL_MS = 3000/);
  assert.match(source, /loadInFlightRef/);
  assert.match(source, /if \(loadInFlightRef\.current\) return/);
  assert.match(source, /function resolvePollInterval/);
  assert.match(source, /if \(connectionState === "degraded"\)/);
  assert.match(source, /hasPendingGuidance = mobileView\?\.pendingGuidance\?\.hasPending === true/);
  assert.match(source, /"codex_working"/);
  assert.match(source, /"supervisor_reviewing"/);
  assert.match(source, /return FAST_POLL_MS/);
  assert.match(source, /连接有波动/);
  assert.match(source, /立即重试/);
  assert.match(source, /onClick=\{\(\) => void load\(\)\}/);
  assert.match(styleSource, /\.notice\.warning/);
});

test("mobile app refreshes immediately when the app returns to the foreground or network", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /document\.addEventListener\("visibilitychange", refreshNow\)/);
  assert.match(source, /window\.addEventListener\("focus", refreshOnFocus\)/);
  assert.match(source, /window\.addEventListener\("online", refreshOnFocus\)/);
  assert.match(source, /window\.addEventListener\("pageshow", refreshOnFocus\)/);
  assert.match(source, /if \(document\.visibilityState === "visible"\)/);
  assert.match(source, /void load\(\{ silent: true \}\)/);
});

test("mobile app caches the latest successful snapshot for refresh and short disconnect recovery", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /MOBILE_SNAPSHOT_KEY = "codex-loop-mobile-snapshot"/);
  assert.match(source, /MOBILE_SNAPSHOT_VERSION = 1/);
  assert.match(source, /MOBILE_SNAPSHOT_MAX_AGE_MS = 1000 \* 60 \* 30/);
  assert.match(source, /function readCachedSnapshot/);
  assert.match(source, /function saveCachedSnapshot/);
  assert.match(source, /function clearCachedSnapshot/);
  assert.match(source, /if \(!parsed\.snapshotSignature\) return null/);
  assert.match(source, /snapshotSignature,\s*\n\s*}\),/);
  assert.match(source, /parsed\.version !== MOBILE_SNAPSHOT_VERSION/);
  assert.match(source, /Date\.now\(\) - cachedAt > MOBILE_SNAPSHOT_MAX_AGE_MS/);
  assert.match(source, /setStatusText\("已载入最近结果"\)/);
  assert.match(source, /setSnapshotSource\("cached"\)/);
  assert.match(source, /setSnapshotSource\("live"\)/);
  assert.match(source, /saveCachedSnapshot\(device\.deviceId,\s*\{/);
  assert.match(source, /clearCachedSnapshot\(\)/);
});

test("mobile app treats cached pending guidance as read-only until live sync returns", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /const \[snapshotSource, setSnapshotSource\] = useState\("live"\)/);
  assert.match(source, /const showingCachedSnapshot = snapshotSource === "cached" && connectionState !== "ready"/);
  assert.match(source, /当前显示的是最近一次缓存结果，恢复连接后会以服务端状态为准/);
  assert.match(source, /当前是离线近况，恢复实时连接后才能发送或修改引导。/);
  assert.match(source, /disabled=\{submitting \|\| showingCachedSnapshot\}/);
  assert.match(source, /disabled=\{showingCachedSnapshot\}/);
  assert.match(source, /textarea[\s\S]*disabled=\{disabled\}/);
  assert.match(source, /aria-label=\{editing \? "修改待合并引导" : "填写下一步引导"\}/);
  assert.match(styleSource, /\.composer-status-line/);
});

test("mobile app composer explains edit and next-guidance modes in product language", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /editing\s*\?\s*"正在修改待合并引导，保存后仍会等 Codex 完成再合并。"/);
  assert.match(source, /"写下下一步补充；系统会等 Codex 完成后再合并，不会打断当前任务。"/);
  assert.match(source, /<span>\{editing \? "修改引导" : "下一步引导"\}<\/span>/);
  assert.match(source, /placeholder="补充你要说的话，等 Codex 完成后合并，不会打断当前任务"/);
});

test("mobile app shows a compact connection badge for live and cached monitoring states", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /const connectionBadge = connectionState === "ready"/);
  assert.match(source, /label: "实时状态"/);
  assert.match(source, /label: "离线近况"/);
  assert.match(source, /当前缓存结果可能落后/);
  assert.match(source, /className=\{`connection-badge is-\$\{connectionBadge\.tone\}`\}/);
  assert.match(styleSource, /\.connection-badge/);
  assert.match(styleSource, /\.connection-badge\.is-live/);
  assert.match(styleSource, /\.connection-badge\.is-cached/);
  assert.match(styleSource, /\.connection-badge\.is-stale/);
  assert.match(styleSource, /\.connection-badge\.is-syncing/);
});

test("mobile app shows a lightweight history refresh notice after reconnecting from cached state", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /const \[conversationRefreshNotice, setConversationRefreshNotice\] = useState\(""\)/);
  assert.match(source, /previousSnapshotSourceRef/);
  assert.match(source, /noticeTimerRef/);
  assert.match(source, /restoredFromCached = previousSnapshotSourceRef\.current === "cached"/);
  assert.match(source, /function getConversationCount/);
  assert.match(source, /hasNewConversationItems = nextConversationCount > previousConversationCount/);
  assert.match(source, /已切回实时状态，并收到新的聊天记录/);
  assert.match(source, /已切回实时状态，历史对话和待合并引导已按服务端最新结果更新/);
  assert.match(source, /window\.setTimeout\(\(\) => \{\s*setConversationRefreshNotice\(""\)/);
  assert.match(source, /}, 6000\)/);
  assert.match(source, /<Conversation mobileView=\{mobileView\} refreshNotice=\{conversationRefreshNotice\} \/>/);
  assert.match(source, /className="conversation-refresh-notice"/);
  assert.match(styleSource, /\.conversation-heading/);
  assert.match(styleSource, /\.conversation-refresh-notice/);
  assert.match(styleSource, /opacity:\s*0\.88/);
});

test("mobile app only auto-follows history near the bottom and offers a jump-to-latest action otherwise", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /function isNearViewportBottom/);
  assert.match(source, /const autoFollowRef = useRef\(true\)/);
  assert.match(source, /const \[showJumpToLatest, setShowJumpToLatest\] = useState\(false\)/);
  assert.match(source, /window\.addEventListener\("scroll", updateFollowState, \{ passive: true \}\)/);
  assert.match(source, /window\.addEventListener\("resize", updateFollowState\)/);
  assert.match(source, /if \(autoFollowRef\.current\) \{\s*bottomRef\.current\?\.scrollIntoView\(\{ block: "end", behavior: "auto" \}\)/);
  assert.match(source, /setShowJumpToLatest\(true\)/);
  assert.match(source, /className="jump-to-latest"/);
  assert.match(source, /查看最新/);
  assert.match(source, /behavior: "smooth"/);
  assert.match(styleSource, /\.jump-to-latest/);
  assert.match(styleSource, /position:\s*sticky/);
  assert.match(styleSource, /backdrop-filter:\s*blur\(12px\)/);
});

test("mobile app builds a snapshot signature from guidance and conversation timing", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /function buildMobileSnapshotSignature/);
  assert.match(source, /mobileView\?\.pendingGuidance\?\.at/);
  assert.match(source, /mobileView\?\.processStatus\?\.lastMergedGuidanceAt/);
  assert.match(source, /mobileView\?\.processStatus\?\.lastDispatchAt \|\| mobileView\?\.thread\?\.lastDispatchAt/);
  assert.match(source, /function getConversationTailAt/);
  assert.match(source, /buildConversationItemsFromMobileView\(mobileView\)/);
  assert.match(source, /currentSnapshotSignature !== lastSnapshotSignatureRef\.current/);
  assert.match(source, /当前缓存结果可能已经落后于任务最新状态/);
});

test("mobile app sanitizes contradictory cached pending guidance before showing it", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /function sanitizeCachedMobileView/);
  assert.match(source, /const hasPendingGuidance = mobileView\?\.processStatus\?\.hasPendingGuidance/);
  assert.match(source, /latestEventType === "pending_guidance_cleared"/);
  assert.match(source, /mergedAt >= pendingAt/);
  assert.match(source, /parsed\.mobile = sanitizedMobile/);
  assert.match(source, /hasPending: false/);
});

test("mobile app is a lightweight task monitor instead of a desktop console clone", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /\/mobile\/view/);
  assert.match(source, /\/mobile\/guidance/);
  assert.match(source, /\/device-pairing\/confirm/);
  assert.match(source, /历史对话/);
  assert.match(source, /发送引导/);
  assert.match(source, /等 Codex 完成后合并/);
  assert.match(source, /待合并/);
  assert.match(source, /pending\.statusLabel/);
  assert.match(source, /pending\.statusDetail/);
  assert.match(source, /pending\.actionLabel/);
  assert.match(source, /presentPendingGuidanceStatus/);
  assert.doesNotMatch(source, /彻底关闭|新建项目|新建任务|Ollama 设置|运行治理/);
  assert.doesNotMatch(source, /app\/web|\\.\\.\/web|MobileTaskApp/);
  assert.match(styleSource, /border-top/);
  assert.match(styleSource, /position:\s*sticky/);
});

test("mobile app can prefill pairing from a browser link and clears the query after success", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /function readPairingQuery/);
  assert.match(source, /url\.searchParams\.get\("sessionId"\)/);
  assert.match(source, /url\.searchParams\.get\("code"\)/);
  assert.match(source, /function clearPairingQueryFromUrl/);
  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /const \[sessionId, setSessionId\] = useState\(pairingQuery\.sessionId \|\| ""\)/);
  assert.match(source, /const \[pairingCode, setPairingCode\] = useState\(pairingQuery\.pairingCode \|\| ""\)/);
  assert.match(source, /const autoConfirmAttemptedRef = useRef\(false\)/);
  assert.match(source, /正在确认绑定/);
  assert.match(source, /void confirmPairingWith\(pairingQuery\.sessionId, pairingQuery\.pairingCode, \{/);
  assert.match(source, /auto:\s*true/);
  assert.match(source, /已从绑定链接带入配对信息，确认后即可长期绑定这台电脑/);
  assert.match(source, /clearPairingQueryFromUrl\(\)/);
});

test("mobile app makes scan-to-pair the primary flow and keeps paste/manual as fallback", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /function canUseBarcodeDetector/);
  assert.match(source, /new window\.BarcodeDetector/);
  assert.match(source, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(source, /const \[scannerOpen, setScannerOpen\] = useState\(false\)/);
  assert.match(source, /const \[scannerSupported\] = useState\(canUseBarcodeDetector\(\)\)/);
  assert.match(source, /扫描二维码绑定/);
  assert.match(source, /无法扫码/);
  assert.match(source, /推荐直接扫描桌面端“移动端使用”里生成的二维码/);
  assert.match(source, /请把二维码放进取景框/);
  assert.match(source, /已识别二维码，确认后即可完成绑定/);
  assert.match(source, /无法打开相机，请允许相机权限，或使用无法扫码时的备用方式/);
  assert.match(source, /当前浏览器暂不支持相机扫码，请使用桌面端显示的绑定链接/);
  assert.match(source, /无法扫码时使用/);
  assert.match(source, /绑定链接或二维码内容/);
  assert.match(source, /会话编号/);
  assert.match(source, /确认码/);
  assert.match(source, /openFallbackPairing/);
  assert.doesNotMatch(source, /codex-loop:\/\/pair\?sessionId=/);
  assert.match(source, /<details className="pairing-fallback" ref=\{fallbackDetailsRef\}>/);
  assert.match(source, /<video ref=\{videoRef\} className="pairing-scanner-video" playsInline muted \/>/);
  assert.match(styleSource, /\.pairing-primary-actions/);
  assert.match(styleSource, /\.pairing-scanner/);
  assert.match(styleSource, /\.pairing-scanner-video/);
  assert.match(styleSource, /\.pairing-fallback/);
});

test("mobile app uses shared conversation items and collapses Codex-style details", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /mobileView\?\.conversationItems/);
  assert.match(source, /detailBlocks/);
  assert.match(source, /conversation-detail-block/);
  assert.match(source, /collapsedByDefault/);
  assert.match(source, /block\.displayLabel \|\| block\.summary/);
  assert.match(styleSource, /\.conversation-detail-block/);
  assert.match(styleSource, /\.conversation-detail-body/);
});

test("mobile app reflects pending guidance in history immediately before the next refresh returns", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /function buildLocalGuidanceConversationItem/);
  assert.match(source, /function mergeConversationItemsWithPending/);
  assert.match(source, /function applyPendingGuidanceToMobileView/);
  assert.match(source, /setMobileView\(\(current\) => applyPendingGuidanceToMobileView\(current, result\.pendingGuidance, text\)\)/);
  assert.match(source, /setMobileView\(\(current\) => applyPendingGuidanceToMobileView\(current, result\.pendingGuidance, ""\)\)/);
  assert.match(source, /currentItems\.filter\(\(item\) => item\?\.role !== "guidance"\)/);
  assert.match(source, /role: "guidance"/);
});

test("mobile app shows a lightweight feedback notice after sending or clearing guidance", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /function GuidanceFeedback/);
  assert.match(source, /const \[guidanceFeedback, setGuidanceFeedback\] = useState\(""\)/);
  assert.match(source, /const \[guidanceFeedbackTone, setGuidanceFeedbackTone\] = useState\("info"\)/);
  assert.match(source, /const guidanceFeedbackTimerRef = useRef\(0\)/);
  assert.match(source, /function presentGuidanceFeedback/);
  assert.match(source, /presentGuidanceFeedback\(\s*presentPendingGuidanceStatus/);
  assert.match(source, /<GuidanceFeedback message=\{guidanceFeedback\} tone=\{guidanceFeedbackTone\} \/>/);
  assert.match(source, /}, 6000\)/);
  assert.match(styleSource, /\.guidance-feedback/);
});

test("mobile app renders Codex replies with markdown code blocks and copyable file paths", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /from "\.\.\/\.\.\/shared\/conversation-format\.mjs"/);
  assert.match(source, /from "\.\.\/\.\.\/shared\/conversation-items\.mjs"/);
  assert.match(source, /splitMarkdownBlocks/);
  assert.match(source, /parseMarkdownTextBlock/);
  assert.match(source, /buildConversationItemsFromMobileView/);
  assert.match(source, /function InlineMessageText/);
  assert.match(source, /function MarkdownMessage/);
  assert.match(source, /markdown-code-block/);
  assert.match(source, /file-path-chip/);
  assert.match(source, /copyText\(block\.content\)/);
  assert.match(source, /onContextMenu/);
  assert.match(source, /title="复制路径"/);
  assert.match(source, /<MarkdownMessage text=\{text\} \/>/);
  assert.doesNotMatch(source, /<pre>\{text\}<\/pre>/);
  assert.match(styleSource, /\.markdown-message/);
  assert.match(styleSource, /\.markdown-code-block/);
  assert.match(styleSource, /\.file-path-chip/);
});

test("mobile app renders history as Codex-like divider flow instead of heavy chat cards", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.doesNotMatch(source, /function ConversationLegacy/);
  assert.match(source, /className=\{isLoop \? "message is-loop" : "message is-codex"\}/);
  assert.match(styleSource, /\.message\s*\{/);
  assert.match(styleSource, /\.message\.is-codex/);
  assert.match(styleSource, /\.message\.is-loop/);
  assert.match(styleSource, /border-top:\s*1px solid rgba\(31,\s*33,\s*31,\s*0\.09\)/);
  const loopBubbleRule = styleSource.match(/\.message\.is-loop details\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(loopBubbleRule, /background:\s*#f6f3ed/);
  assert.doesNotMatch(loopBubbleRule, /background:\s*#242620/);
  assert.doesNotMatch(loopBubbleRule, /color:\s*#fff/);
});

test("mobile app surfaces production monitoring signals in one compact status block", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /function deriveRealtimeStageSnapshot/);
  assert.match(source, /const serverPhaseLabel = asText\(process\.realtimePhaseLabel\)/);
  assert.match(source, /const serverActionLabel = asText\(process\.realtimeRecentActionLabel\)/);
  assert.match(source, /serverPhaseLabel \|\| presentProcessStageLabel\(process\.state\)/);
  assert.match(source, /serverActionLabel \|\|/);
  assert.match(source, /latestEventType === "codex_followup_dispatching"/);
  assert.match(source, /latestEventType === "codex_followup_sent_waiting"/);
  assert.match(source, /latestEventType === "codex_followup_dispatched"/);
  assert.match(source, /刚发出，待送达确认/);
  assert.match(source, /已送达，等 Codex 完成/);
  assert.match(source, /可继续下一轮/);
  assert.match(source, /function presentMonitorText/);
  assert.match(source, /本地模型监督流程正在结合最新回复决定下一步/);
  assert.match(source, /holdReason/);
  assert.match(source, /pendingGuidancePreview/);
  assert.match(source, /lastMergedGuidanceStatus/);
  assert.match(source, /lastMergedGuidancePreview/);
  assert.match(source, /已合并补充/);
  assert.match(source, /supervisorVerificationLabel/);
  assert.match(source, /supervisorVerificationAction/);
  assert.match(source, /supervisorPerspectiveRows/);
  assert.match(source, /latestInstructionSourceDetail/);
  assert.match(source, /function buildRealtimeStageRows/);
  assert.match(source, /function buildRealtimeEvents/);
  assert.match(source, /status-stage-strip/);
  assert.match(source, /当前进程节奏/);
  assert.match(source, /status-timeline/);
  assert.match(source, /最近进程/);
  assert.match(source, /只保留最近关键动作，方便远程判断是否需要介入/);
  assert.match(source, /状态细节|等待原因|独立验收|模型来源|监督视角/);
  assert.match(styleSource, /\.status-detail/);
  assert.match(styleSource, /\.status-detail-grid/);
  assert.match(styleSource, /\.status-stage-strip/);
  assert.match(styleSource, /\.status-timeline/);
});

test("mobile app shows production status and stale observation guidance", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /\/production-status/);
  assert.match(source, /\/production-preflight/);
  assert.match(source, /productionStatus/);
  assert.match(source, /productionPreflight/);
  assert.match(source, /productionStatus\?\.target/);
  assert.match(source, /productionPreflight\?\.target/);
  assert.match(source, /验证目标/);
  assert.match(source, /启动预检/);
  assert.match(source, /可以启动|先别启动|等待中/);
  assert.match(source, /shortThreadId/);
  assert.match(source, /readiness\?\.stage/);
  assert.match(source, /生产阶段/);
  assert.match(source, /短时试用|可长跑|观察中|需处理/);
  assert.match(source, /生产观测|生产状态/);
  assert.match(source, /真实运行观测/);
  assert.match(source, /已过期|重新启动一次真实任务|重新运行生产观测/);
});

test("mobile app shows structured maturity and remaining production gaps", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /productionStatus\?\.maturity/);
  assert.match(source, /maturity\?\.label/);
  assert.match(source, /maturity\?\.percent/);
  assert.match(source, /maturity\?\.canLongRun/);
  assert.match(source, /生产成熟度/);
  assert.match(source, /剩余缺口/);
});

test("mobile app shows closed-loop evidence progress for remote supervision", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /closedLoopCount/);
  assert.match(source, /closedLoopTarget/);
  assert.match(source, /productionStatus\?\.closedLoopEvidence/);
  assert.match(source, /闭环证据/);
  assert.match(source, /长跑判断/);
  assert.match(source, /状态细节/);
  assert.match(source, /还差.*轮|已达到长期运行基本证据/);
  assert.match(styleSource, /\.status-detail/);
  assert.match(styleSource, /\.status-detail-grid/);
});

test("mobile app shows guidance merge evidence for remote supervision", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /productionStatus\?\.guidanceEvidence/);
  assert.match(source, /guidanceEvidenceCount/);
  assert.match(source, /guidanceEvidenceTarget/);
  assert.match(source, /补充合并证据/);
  assert.match(source, /用户补充|补充引导/);
});

test("mobile app folds the next real closed-loop evidence plan into status details", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /closedLoopEvidence\.evidencePlan/);
  assert.match(source, /evidencePlanSteps/);
  assert.match(source, /下一轮验证/);
  assert.match(source, /确认目标/);
  assert.match(source, /发送一轮/);
  assert.match(source, /等待 Codex 完成/);
  assert.match(source, /监督复盘/);
  assert.match(source, /重新检查/);
  assert.match(source, /status-detail/);
  assert.doesNotMatch(source, /closed-loop-plan-card/);
});

test("mobile app shows supervisor screenshot evidence without adding noisy cards", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /supervisorVerificationEvidencePreview/);
  assert.match(source, /supervisorVerificationEvidenceCount/);
  assert.match(source, /视觉证据/);
  assert.match(source, /status-detail-row/);
  assert.doesNotMatch(source, /screenshot-evidence-card/);
  assert.match(styleSource, /\.status-detail-row/);
});

test("mobile app manifest supports installable Chinese product naming", async () => {
  const manifest = JSON.parse(await read("app/mobile/manifest.webmanifest"));

  assert.equal(manifest.name, "codex-loop 移动监控");
  assert.equal(manifest.short_name, "codex-loop");
  assert.equal(manifest.start_url, "/mobile-app");
  assert.equal(manifest.scope, "/mobile-app/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "zh-CN");
});

test("docs describe the shipped mobile app shell and keep only native wrapper as future work", async () => {
  const readme = await read("README.md");
  const roadmap = await read("docs/product-roadmap.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  for (const source of [readme, roadmap, architecture]) {
    assert.match(source, /app\/mobile/);
    assert.match(source, /独立移动端|移动端 App\/PWA|PWA 壳/);
    assert.doesNotMatch(source, /独立 `app\/mobile` 工程仍是后续|完整 `app\/mobile` 仍按下一批开发|原生 App 和独立 `app\/mobile` 工程仍是下一批/);
  }
});
