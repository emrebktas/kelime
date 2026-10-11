"""`npx cap add android` ile üretilen projeyi derleme için ayarlar (GitHub Actions'ta çalışır).

Kullanım:
  python3 android-build/patch.py gradle <sürüm-no>   -> sürüm numarası, imza ayarı, TTS izni
  python3 android-build/patch.py csp                  -> paketlenen index.html'de CSP'yi Capacitor'a uyarla
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "android"


def patch_gradle(build_no: int) -> None:
    gradle = ROOT / "app" / "build.gradle"
    s = gradle.read_text(encoding="utf-8")
    s = re.sub(r"versionCode \d+", f"versionCode {build_no}", s)
    s = re.sub(r'versionName "[^"]*"', f'versionName "1.0.{build_no}"', s)
    signing = """    signingConfigs {
        release {
            if (System.getenv("KELIME_KEYSTORE")) {
                storeFile file(System.getenv("KELIME_KEYSTORE"))
                storePassword System.getenv("KELIME_KEYSTORE_PASSWORD")
                keyAlias "kelime"
                keyPassword System.getenv("KELIME_KEYSTORE_PASSWORD")
                storeType "pkcs12"
            }
        }
    }
"""
    assert "    buildTypes {" in s, "build.gradle beklenen biçimde değil"
    s = s.replace("    buildTypes {", signing + "    buildTypes {", 1)
    s, n = re.subn(r"(buildTypes \{\s*release \{)", r"\1\n            signingConfig signingConfigs.release", s, count=1)
    assert n == 1, "release derleme türü bulunamadı"
    gradle.write_text(s, encoding="utf-8")

    # Android 11+ cihazlarda konuşma motorunu bulabilmek için gerekli
    manifest = ROOT / "app" / "src" / "main" / "AndroidManifest.xml"
    x = manifest.read_text(encoding="utf-8")
    if "TTS_SERVICE" not in x:
        x = x.replace("<application", """<queries>
        <intent>
            <action android:name="android.intent.action.TTS_SERVICE" />
        </intent>
    </queries>

    <application""", 1)
    # Çalışma sayacı: süre dolunca tam zamanında bildirim (Android 12+ kesin alarm izni)
    if "SCHEDULE_EXACT_ALARM" not in x:
        x = x.replace("<application", """<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />

    <application""", 1)
    manifest.write_text(x, encoding="utf-8")

    # Bildirim çubuğu simgesi (Android tek renkli ister): kelime kartı
    drawable = ROOT / "app" / "src" / "main" / "res" / "drawable" / "ic_stat_kelime.xml"
    drawable.parent.mkdir(parents=True, exist_ok=True)
    drawable.write_text("""<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M7,3h10a3,3 0,0 1,3 3v12a3,3 0,0 1,-3 3H7a3,3 0,0 1,-3 -3V6A3,3 0,0 1,7 3zM7,5a1,1 0,0 0,-1 1v12a1,1 0,0 0,1 1h10a1,1 0,0 0,1 -1V6a1,1 0,0 0,-1 -1zM8,7.5h8v2.2H8zM8,12h8v1.6H8zM8,15.5h5v1.6H8z" />
</vector>
""", encoding="utf-8")
    print(f"gradle ayarlandı: sürüm 1.0.{build_no}")


def patch_csp() -> None:
    # Capacitor köprü kodunu sayfaya satır içi <script> olarak ekler; CSP buna izin vermeli.
    index = ROOT / "app" / "src" / "main" / "assets" / "public" / "index.html"
    s = index.read_text(encoding="utf-8")
    assert "script-src 'self';" in s, "CSP bulunamadı"
    s = s.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';", 1)
    index.write_text(s, encoding="utf-8")
    print("CSP Capacitor için ayarlandı")


if __name__ == "__main__":
    if sys.argv[1] == "gradle":
        patch_gradle(int(sys.argv[2]))
    elif sys.argv[1] == "csp":
        patch_csp()
    else:
        raise SystemExit("bilinmeyen komut")
