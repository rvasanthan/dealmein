package com.dealmein;

import com.dealmein.util.Csv;
import com.dealmein.util.Money;
import com.dealmein.util.UrlValidator;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.junit.jupiter.api.Assertions.*;

class UnitTests {
    @Test
    void moneyIsDecimalSafeAndRejectsAmbiguousText() {
        assertEquals(new BigDecimal("1299.99"), Money.parse("$1,299.99"));
        assertNull(Money.parse("  "));
        assertThrows(IllegalArgumentException.class, () -> Money.parse("$59.99 after $10 gift card"));
        assertThrows(IllegalArgumentException.class, () -> Money.parse("1.234"));
    }

    @Test
    void discountOnlyWhenReferenceIsHigher() {
        assertEquals(20, Money.discountPercent(new BigDecimal("100.00"), new BigDecimal("80.00")));
        assertNull(Money.discountPercent(null, new BigDecimal("80.00")));
        assertNull(Money.discountPercent(new BigDecimal("50.00"), new BigDecimal("80.00")));
        assertNull(Money.discountPercent(new BigDecimal("100.00"), null));
    }

    @Test
    void urlSchemesAreRestricted() {
        assertNotNull(UrlValidator.safeHttpUrl("https://example.com/a?b=1"));
        assertNull(UrlValidator.safeHttpUrl("javascript:alert(1)"));
        assertNull(UrlValidator.safeHttpUrl("ftp://example.com"));
        assertNull(UrlValidator.safeHttpUrl("https://user:pw@example.com"));
        assertNull(UrlValidator.safeHttpUrl("//example.com"));
    }

    @Test
    void csvNeutralizesFormulas() {
        assertEquals("\"'=SUM(A1)\"", Csv.cell("=SUM(A1)"));
        assertEquals("\"'+1\"", Csv.cell("+1"));
        assertEquals("\"'@x\"", Csv.cell("@x"));
        assertEquals("\"a\"\"b\"", Csv.cell("a\"b"));
        assertEquals("", Csv.cell(null));
    }
}
