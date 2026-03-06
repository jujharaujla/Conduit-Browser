'use strict';

module.exports = {
  appId: 'com.jujharaujla.conduit',
  productName: 'Conduit',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  files: [
    'src/**/*',
    'package.json',
    'README.md',
    'LICENSE',
    '!src/**/*.map',
  ],
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  publish: [
    {
      provider: 'github',
      owner: 'jujharaujla',
      repo: 'conduit',
    },
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.svg',
    artifactName: 'Conduit-${version}-mac-${arch}.${ext}',
    target: ['dmg', 'zip'],
    minimumSystemVersion: '12.0',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: {
    title: 'Conduit ${version}',
    sign: false,
  },
  win: {
    icon: 'build/icon.svg',
    target: ['nsis', 'portable'],
    legalTrademarks: 'Conduit',
  },
  nsis: {
    artifactName: 'Conduit-${version}-windows-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Conduit',
    uninstallDisplayName: 'Conduit',
    deleteAppDataOnUninstall: false,
  },
  portable: {
    artifactName: 'Conduit-${version}-windows-${arch}-portable.${ext}',
  },
  linux: {
    icon: 'build/icon.svg',
    target: ['AppImage'],
    category: 'Utility',
    executableName: 'conduit',
  },
};
