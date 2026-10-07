# AirLLM Desktop

AirLLM Desktop, Hugging Face model depolarını yerel bir OpenAI uyumlu API olarak sunmak için hazırlanmış Linux masaüstü uygulamasıdır. Hugging Face model adresini girin; uygulama kullanıcı hesabınız altında ayrı bir Python ortamı oluşturur, AirLLM bağımlılıklarını kurar, modeli yükler ve API’yi başlatır.

## Özellikler

- Model yükleme ve AirLLM katman hazırlama ilerlemesini gösterir.
- API hazır olduğunda yeşil durum göstergesi verir; Open WebUI isteği işlenirken yanıt üretim durumunu gösterir.
- OpenAI uyumlu `/v1/models` ve `/v1/chat/completions` uç noktaları sunar.
- Normal ve Server-Sent Events (SSE) streaming sohbet yanıtlarını destekler.
- Çalışan yerel API’yi veya paket kurulumunu arayüzden durdurabilir.
- Model dosyalarını AppImage içine koymaz; Hugging Face önbelleğinde saklar.

## Linux AppImage

En yeni AppImage dosyasını GitHub Actions içindeki başarılı Linux Build çalışmasının `AppImage` artifact’inden indirin. İndirilen dosyaya çalıştırma izni verip açın:

```bash
chmod +x "AirLLM Desktop-1.0.0.AppImage"
./"AirLLM Desktop-1.0.0.AppImage"
```

Uygulamada Hugging Face model kimliğini (ör. `Qwen/Qwen3-8B`) veya yerel model klasör yolunu girip **Modeli başlat**’a tıklayın. İlk çalıştırma Python paketlerini ve model dosyalarını indirir; model boyutuna ve bağlantıya göre uzun sürebilir. Sonraki çalıştırmalarda paketler ve model önbelleği tekrar indirilmez.

Uygulama Linux x86-64 AppImage olarak paketlenir. Python 3.11–3.13 sürümlerinden birini bulup kullanıcı alanında sanal ortam oluşturur. `sudo pip` veya sistem Python’una kurulum yapmaz.

## Model seçimi

AirLLM, Transformers mimarisine uygun Hugging Face modelleriyle çalışır. Depo kimliğini girin; tek bir ağırlık dosyasının URL’sini girmeyin. Model deposunda `config.json`, tokenizer dosyaları ve Transformers tarafından tanınan ağırlıklar bulunmalıdır. Uyum, model mimarisine ve AirLLM/Transformers sürümüne göre değişebilir.

GGUF, MLX ve özel çalışma zamanı gerektiren checkpoint’ler AirLLM’in standart yükleme akışına uygun değildir. MTP/DFlash gibi yardımcı taslak modeller tek başlarına sohbet modeli olarak kullanılamaz. Bir modelin `safetensors` uzantısında olması tek başına AirLLM uyumluluğunu garanti etmez.

## Open WebUI ile kullanma

1. AirLLM Desktop’ta modeli başlatın ve durum göstergesinin yeşile dönmesini bekleyin.
2. Open WebUI’de OpenAI uyumlu bağlantının Base URL alanına aşağıdaki adresi girin:

   ```text
   http://127.0.0.1:8000/v1
   ```

3. Model listesinde yüklenen model kimliğini seçin. Sunucu API anahtarı doğrulamaz; Open WebUI zorunlu tutarsa yerel kullanım için herhangi bir yer tutucu değer girilebilir.

API uç noktaları:

- Sağlık: `GET http://127.0.0.1:8000/health`
- Durum: `GET http://127.0.0.1:8000/status`
- Modeller: `GET http://127.0.0.1:8000/v1/models`
- Sohbet: `POST http://127.0.0.1:8000/v1/chat/completions`

Örnek streaming isteği:

```bash
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-8B","messages":[{"role":"user","content":"Merhaba"}],"stream":true}'
```

## Sistem gereksinimleri ve performans

- Linux x86-64 ve AppImage çalıştırma desteği.
- İlk kurulumda internet bağlantısı.
- Python 3.11, 3.12 veya 3.13.
- Modelin indirilmesi ve AirLLM’in katman shard’larını hazırlaması için yeterli disk alanı. Orijinal ağırlıkların yanında dönüştürülmüş shard’lar da yer kaplayabilir.
- GPU zorunlu değildir; CUDA destekli NVIDIA GPU önerilir. Gereken VRAM, RAM ve disk alanı seçilen modele bağlıdır.

AirLLM katmanları diskten yükleyebildiği için belleği sınırlı sistemlerde büyük modelleri çalıştırmaya yardımcı olabilir; bunun karşılığında yükleme ve token üretimi klasik GPU sunucularından çok daha yavaş olabilir. Model boyutunu sistem kaynaklarına göre seçin.

## Kaynaktan çalıştırma

Node.js ve npm ile masaüstü arayüzünü başlatın:

```bash
npm ci
npm start
```

Linux AppImage oluşturmak için:

```bash
npm run dist:linux
```

Çıktı `dist/AirLLM Desktop-1.0.0.AppImage` konumunda oluşur. Python bağımlılıkları uygulama ilk kez model başlatırken kullanıcı alanındaki sanal ortama kurulur.

## Sorun giderme

- **Kurulum başlatılıyor ekranında kalıyor:** İşlem günlüğünü açın. İlk kurulum PyTorch ve CUDA bağımlılıkları nedeniyle birkaç GB veri indirebilir.
- **PEP 668 / externally-managed-environment:** Uygulama kendi sanal ortamını kullanır. Elle kurulum yapıyorsanız sistem Python’u yerine `python -m venv .venv` kullanın; `sudo pip` çalıştırmayın.
- **Model yükleme hatası:** Model kartının Transformers kullanımını ve AirLLM mimari desteğini kontrol edin. GGUF/MLX veya yalnızca yardımcı checkpoint depoları uygun değildir.
- **Open WebUI bağlantı hatası:** Önce `http://127.0.0.1:8000/health` adresini açın ve API’nin yeşil/aktif durumda olduğunu doğrulayın.
- **Çok yavaş yanıt:** AirLLM’in disk üzerinden katman akışı yavaş olabilir. Daha küçük bir model deneyin veya modeliniz için optimize edilmiş başka bir inference sunucusu kullanın.

## Güvenlik notu

Varsayılan API yalnızca `127.0.0.1` üzerinden dinler ve kimlik doğrulama yapmaz. API’yi ağa veya internete açmayın; erişimi genişletmeden önce kimlik doğrulama ve ağ koruması ekleyin. Erişim kısıtlı Hugging Face modelleri için token uygulama oturumu boyunca kullanılır ve ayarlara yazılmaz.

## Lisans

Bu proje MIT lisansı ile dağıtılır. AirLLM, PyTorch, Transformers, Electron ve diğer bağımlılıklar kendi lisanslarına tabidir.

## DONATE

USDT TRC20 | `TYCK6ZyMS6UDt787foPH2QwFuvkdqMw1Jv`

USDT BSC20 | `0x15aac92a1945ddbe5c79304bfa388d6be99b26a3`

Created by **TAPSIN**
