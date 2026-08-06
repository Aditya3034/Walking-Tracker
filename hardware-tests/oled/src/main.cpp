// SSD1306 128x64 OLED test on XIAO ESP32-C3
//
// Wiring:
//   OLED VCC -> XIAO 3V3
//   OLED GND -> XIAO GND
//   OLED SDA -> XIAO D4 (GPIO 6)
//   OLED SCL -> XIAO D5 (GPIO 7)
//
// Library: u8g2 (same as the existing esp32/src/main.cpp firmware)

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Full-buffer driver — uses ~1KB RAM but allows full-screen drawing operations
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("==== OLED Test ====");

  Wire.begin(6, 7);
  Wire.setClock(400000);

  // Scan I2C to confirm OLED is reachable
  bool oledFound = false;
  for (uint8_t addr = 0x3C; addr <= 0x3D; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("OLED found at 0x%02X\n", addr);
      oledFound = true;
    }
  }
  if (!oledFound) {
    Serial.println("OLED NOT detected — check wiring (VCC/GND/SDA/SCL)");
  }

  // Initialize the display
  oled.setI2CAddress(0x3C * 2);  // u8g2 wants the 8-bit address (shifted left)
  oled.begin();
  oled.clearBuffer();
  oled.setFont(u8g2_font_ncenB10_tr);  // bold serif, 10pt
  oled.drawStr(8, 14, "Hello!");
  oled.setFont(u8g2_font_6x10_tr);
  oled.drawStr(0, 30, "OLED connected.");
  oled.drawStr(0, 42, "softwear.pet test");
  oled.drawFrame(0, 50, 128, 14);
  oled.drawStr(4, 61, "Counter:");
  oled.sendBuffer();
}

void loop() {
  static int n = 0;
  n++;

  // Update just the counter region — leave the rest in place
  oled.setDrawColor(0);
  oled.drawBox(60, 51, 65, 12);  // clear old number
  oled.setDrawColor(1);
  char buf[16];
  snprintf(buf, sizeof(buf), "%d", n);
  oled.drawStr(60, 61, buf);
  oled.sendBuffer();

  Serial.printf("Tick %d\n", n);
  delay(500);
}
