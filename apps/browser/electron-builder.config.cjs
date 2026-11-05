// electron-builder configuration. NOAI_TEST_BUILD=1 keeps the Node inspector fuse on so the
// e2e suite (Playwright) can drive the packaged app; release builds turn it off.
const testBuild = process.env.NOAI_TEST_BUILD === '1';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.noaibrowser.app',
  productName: 'No-AI Browser',
  copyright: 'No-AI Browser',
  directories: { output: testBuild ? 'release/test' : 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json', '!**/*.map'],
  extraResources: [{ from: '../../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    target: testBuild ? [{ target: 'dir', arch: ['arm64'] }] : [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    minimumSystemVersion: '13.0',
    // Ad-hoc signature: no Developer ID certificate is available for notarization yet.
    identity: '-',
    hardenedRuntime: false,
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
    title: 'No-AI Browser ${version}',
    artifactName: 'No-AI-Browser-${version}-${arch}.${ext}',
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
