// pseudo.c — describes the decryption logic used by the ELF binary
// (provided for analysis; the real binary would call this at runtime)
#include <stdint.h>
#include <string.h>

static const uint8_t ENCRYPTED[] = {
    // XOR'd with key 0x42, length 27
    // extracted from .rodata section
};

static const uint8_t KEY = 0x42;

void decrypt_flag(char *out, size_t len) {
    for (size_t i = 0; i < len; i++) {
        out[i] = ENCRYPTED[i] ^ KEY;
    }
}

int main() {
    char flag[64] = {0};
    decrypt_flag(flag, sizeof(ENCRYPTED));
    // prints flag
    return 0;
}
