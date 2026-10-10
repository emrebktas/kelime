# Kelime

Anki tarzı kelime kartı uygulaması: IELTS, Almanca ve diğer diller için aralıklı tekrar.
Windows, Mac, Android ve iPhone'da çalışır. Cihazlar arasında senkron, ortak desteler ve değişiklik geçmişi vardır.

## Yapı

| Klasör | İçerik |
|---|---|
| `web/` | Uygulamanın kendisi (PWA). Derleme adımı yok, düz HTML/CSS/JS. |
| `web/js/store.js` | Yerel veri (IndexedDB). Her şey önce cihazda çalışır, internet gerekmez. |
| `web/js/sync.js` | Supabase ile hesap, senkron, paylaşım ve geçmiş. |
| `web/js/srs.js` | Aralıklı tekrar zamanlaması. |
| `web/js/config.js` | Supabase proje adresi ve herkese açık (anon) anahtar. |
| `supabase/migrations/` | Veritabanı şeması: tablolar, erişim kuralları, geçmiş tetikleyicileri. |
| `app.py`, `ui/` | Eski masaüstü sürümü (sadece Windows, senkronsuz). |

## Nasıl çalışır

- **Senkron:** Değişiklikler önce cihaza yazılır, internet varken birkaç saniye içinde sunucuya gönderilir.
  Diğer cihazlar uygulama açıldığında, pencereye dönüldüğünde ve dakikada bir değişiklikleri çeker.
- **Ortak desteler:** Deste sahibi “Paylaş” ile 8 karakterlik bir kod verir; kodu giren kişi desteye katılır.
  Kartlar ortaktır, herkesin çalışma ilerlemesi ayrıdır. Yeni üyeler görüntüleyicidir; sahip düzenleme yetkisi verebilir.
- **Değişiklik geçmişi:** Her destede kim, hangi cihazdan, ne zaman, neyi neyle değiştirdi kaydedilir (“Geçmiş”).
- **Güvenlik:** Veritabanındaki satır düzeyi kurallar (RLS) herkesin sadece üyesi olduğu desteleri görmesini,
  sadece yetkili olduğu kartları değiştirmesini ve sadece kendi ilerlemesine erişmesini sağlar.

## Yerelde çalıştırma

```bash
python -m http.server 5173 --directory web
```

Sonra tarayıcıda `http://localhost:5173`. `config.js` boşsa uygulama hesapsız, sadece o cihazda çalışır.

## JSON formatı

```json
{
  "deck": "IELTS Kelimeler",
  "language": "en",
  "cards": [
    {
      "word": "abundant",
      "translation": "bol, bereketli",
      "sentence": "The region has abundant natural resources.",
      "synonyms": ["plentiful", "ample", "copious"]
    }
  ]
}
```

- Sadece kart dizisi (`[ {...}, {...} ]`) ya da birden çok deste (`{ "decks": [...] }`) de kabul edilir.
- Alan adları esnektir: `word`/`kelime`/`wort`, `translation`/`turkish`/`anlam`, `sentence`/`example`/`cümle`,
  `synonyms` (dizi ya da virgüllü metin), `notes`. Diğer alanlar (ör. `plural`) kartın arkasında ek bilgi olarak görünür.
- Hesap menüsündeki “Tüm verileri yedekle” dosyası çalışma ilerlemesini de içerir ve aynı yoldan geri yüklenir.

## Kısayollar (bilgisayarda)

| Yer | Tuş | İşlev |
|---|---|---|
| Her yer | Ctrl+N / Ctrl+O | Yeni deste / JSON içe aktar |
| Deste | Enter / N / Ctrl+F | Çalış / kart ekle / ara |
| Çalışma | Space | Cevabı göster, sonra "İyi" |
| Çalışma | 1 2 3 4 | Tekrar / Zor / İyi / Kolay |
| Çalışma | R / E / Ctrl+Z / Esc | Seslendir / düzenle / geri al / çık |

Telefonda karta dokunmak kartı çevirir.
