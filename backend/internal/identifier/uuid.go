package identifier

// IsCanonicalUUIDv7 accepts only lowercase, hyphenated RFC 9562 UUIDv7 values.
func IsCanonicalUUIDv7(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
		value[14] != '7' || !isUUIDVariant(value[19]) {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !isLowerHex(character) {
			return false
		}
	}
	return true
}

func isUUIDVariant(value byte) bool {
	return value == '8' || value == '9' || value == 'a' || value == 'b'
}

func isLowerHex(value rune) bool {
	return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f')
}
