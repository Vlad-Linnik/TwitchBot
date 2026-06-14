function normalizeText(text) {
  // Unicode normalization
  let normalized = text.normalize('NFKD');

  // Lowercase
  normalized = normalized.toLowerCase();

  // Замена кириллицы на латиницу (только визуально похожие)
  const cyrillicMap = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
    'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't',
    'н': 'h', 'в': 'b', 'і': 'i', 'ї': 'i', 'й': 'i',
    'л': 'l', 'д': 'd', 'з': '3'
  };

  normalized = normalized.replace(/[а-яіїє]/g, ch => cyrillicMap[ch] || ch);

  // Удаление всего кроме букв, цифр и _
  normalized = normalized.replace(/[^a-z0-9_]/g, '');

  return normalized;
}

function detectObfuscatedSignature(message, signature) {
  const normalized = normalizeText(message);
  return normalized.includes(signature);
}

module.exports = { normalizeText, detectObfuscatedSignature };
