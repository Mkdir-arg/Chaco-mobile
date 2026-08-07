const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withPlugins,
} = require('expo/config-plugins');

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">datanach.ecomdev.ar</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/letsencrypt_yr2" />
        </trust-anchors>
    </domain-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.5.6.209</domain>
    </domain-config>
</network-security-config>
`;

const withAndroidManifestNetworkSecurityConfig = (config) =>
  withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults);
    application.$['android:usesCleartextTraffic'] = 'true';
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return modConfig;
  });

const withAndroidNetworkSecurityConfigFile = (config) =>
  withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const xmlDir = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      const rawDir = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'raw');
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.mkdir(rawDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG
      );
      await fs.promises.copyFile(
        path.join(modConfig.modRequest.projectRoot, 'assets', 'certs', 'letsencrypt_yr2.pem'),
        path.join(rawDir, 'letsencrypt_yr2.pem')
      );
      return modConfig;
    },
  ]);

module.exports = (config) =>
  withPlugins(config, [
    withAndroidManifestNetworkSecurityConfig,
    withAndroidNetworkSecurityConfigFile,
  ]);
