/**
 * 子ども向け判定。
 * 同行者タグ、年齢別料金、入場できるという説明だけでは true にしない。
 * 対象者が明確なときだけ true。明確に対象外のときだけ false。それ以外は null。
 */

const EXCLUDED_RE =
  /未就学児(?:の)?入場不可|未就学児不可|幼児(?:の)?入場不可|乳幼児(?:の)?入場不可|子ども(?:の)?入場不可|子供(?:の)?入場不可|こども(?:の)?入場不可|小学生(?:の)?入場不可|子ども不可|子供不可|こども不可|大人限定|大人向け|成人限定|未成年不可/

const PRICE_OR_ADMISSION_RE =
  /(?:高校生|中学生|小学生|未就学児|幼児|乳幼児|子ども|子供|こども|18歳未満|学生)(?:以下|未満)?.{0,16}(?:無料|円|割引|料金)|(?:子ども|子供|こども)も入場|(?:子ども|子供|こども)料金|学生料金/g

const TARGETED_RE =
  /子ども向け|子供向け|こども向け|キッズ向け|キッズ|ファミリー向け|親子向け|親子で参加|親子参加|親子で学べ|親子で楽し|小学生を対象|小学生対象|小学生向け|未就学児を対象|未就学児対象|未就学児向け|幼児向け|乳幼児向け|0歳から/

/** 本文・料金・対象者欄。単語の出現だけでは判定しない。 */
export function inferKidsFromAudienceText(
  text: string | null | undefined,
): boolean | null {
  const raw = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (!raw) return null
  if (EXCLUDED_RE.test(raw)) return false
  const withoutPrices = raw.replace(PRICE_OR_ADMISSION_RE, ' ')
  if (TARGETED_RE.test(withoutPrices)) return true
  return null
}
