function normalizeText(text) {
  // 1. Unicode normalization
  let normalized = text.normalize('NFKD');

  // 2. Lowercase
  normalized = normalized.toLowerCase();

  // 3. Замена кириллицы на латиницу (только визуально похожие)
  const cyrillicMap = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
    'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't',
    'н': 'h', 'в': 'b', 'і': 'i', 'ї': 'i', 'й': 'i',
    'л': 'l', 'д': 'd', 'з': '3'
  };

  normalized = normalized.replace(/[а-яіїє]/g, ch => cyrillicMap[ch] || ch);

  // 4. Удаляем всё кроме букв, цифр и _
  normalized = normalized.replace(/[^a-z0-9_]/g, '');

  return normalized;
}

function detectObfuscatedSignature(message, signature) {
  const normalized = normalizeText(message);
  return normalized.includes(signature);
}

module.exports = { normalizeText, detectObfuscatedSignature };
