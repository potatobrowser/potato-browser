// electron-builder configuration. POTATO_TEST_BUILD=1 keeps the Node inspector fuse on so the
// e2e suite (Playwright) can drive the packaged app; release builds turn it off.
const testBuild = process.env.POTATO_TEST_BUILD === '1';
// Releases sign with the Developer ID in CSC_LINK (a base64 .p12) and notarize with the App Store
// Connect key in APPLE_API_KEY*; everything else, like a build from source, is ad-hoc signed.
const signed = !testBuild && !!process.env.CSC_LINK;
const notarizing = signed && !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
// POTATO_ARCH=arm64 or x64 builds one DMG (scripts/dist.mjs --arch); releases build both.
const archs = ['arm64', 'x64'].includes(process.env.POTATO_ARCH) ? [process.env.POTATO_ARCH] : ['arm64', 'x64'];

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.potatobrowser.app',
  productName: 'Potato Browser',
  copyright: 'Potato Browser',
  directories: { output: testBuild ? 'release/test' : 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json', '!**/*.map'],
  extraResources: [{ from: '../../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }],
  // Our own notarize step: it retries stapling, which electron-builder's built-in one does not.
  afterSign: notarizing ? 'scripts/notarize.cjs' : undefined,
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    target: testBuild ? [{ target: 'dir', arch: ['arm64'] }] : [{ target: 'dmg', arch: archs }],
    minimumSystemVersion: '13.0',
    // undefined: the identity in CSC_LINK. '-': ad-hoc, so arm64 builds still launch.
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    entitlements: signed ? 'build/entitlements.mac.plist' : null,
    notarize: false,
    gatekeeperAssess: false,
    darkModeSupport: true,
    protocols: [{ name: 'Web site URL', schemes: ['http', 'https'], role: 'Viewer' }],
    extendInfo: {
      NSCameraUsageDescription: 'Websites you allow can use the camera, for example for video calls.',
      NSMicrophoneUsageDescription: 'Websites you allow can use the microphone, for example for video calls.',
      NSLocationUsageDescription: 'Websites you allow can see your approximate location.',
      NSLocationWhenInUseUsageDescription: 'Websites you allow can see your approximate location.',
      NSBluetoothAlwaysUsageDescription: 'Websites you allow can connect to Bluetooth devices.',
      LSApplicationCategoryType: 'public.app-category.productivity',
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'HTML document',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.html', 'public.xhtml'],
        },
      ],
    },
  },
  dmg: {
    // The release workflow notarizes and staples the signed DMG too.
    sign: signed,
    title: 'Potato Browser ${version}',
    artifactName: 'Potato-Browser-${version}-${arch}.${ext}',
    background: 'build/dmg-background.png',
    window: { width: 540, height: 380 },
    iconSize: 96,
    contents: [
      { x: 140, y: 180, type: 'file' },
      { x: 400, y: 180, type: 'link', path: '/Applications' },
    ],
  },
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: testBuild,
    enableEmbeddedAsarIntegrityValidation: !testBuild,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
};
