import { crc8, buildCommandPacket, parseResponsePacket, RW_GET, RW_SET } from './protocol';

/**
 * CRC-8 和组包/解包自测
 */
export function selfTest(): void {
    // Test 1: Get IP  →  AA 06 07 00 83 50
    const t1 = crc8([0xAA, 0x06, 0x07, 0x00, 0x83]);
    console.assert(t1 === 0x50, `CRC test 1 failed: got 0x${t1.toString(16)}, expected 0x50`);

    // Test 2: Get Time  →  AA 06 07 00 85 D1
    const t2 = crc8([0xAA, 0x06, 0x07, 0x00, 0x85]);
    console.assert(t2 === 0xD1, `CRC test 2 failed: got 0x${t2.toString(16)}, expected 0xD1`);

    // Test 3: Set IP  →  AA 12 07 01 83 + "192.168.1.65" ascii  →  E8
    const ipBytes = [...Buffer.from('192.168.1.65', 'ascii')];
    const t3 = crc8([0xAA, 0x12, 0x07, 0x01, 0x83, ...ipBytes]);
    console.assert(t3 === 0xE8, `CRC test 3 failed: got 0x${t3.toString(16)}, expected 0xE8`);

    // Test 4: Set Time  →  AA 19 07 01 85 + "2024-01-01 05:15:41" ascii  →  1A
    const timeBytes = [...Buffer.from('2024-01-01 05:15:41', 'ascii')];
    const t4 = crc8([0xAA, 0x19, 0x07, 0x01, 0x85, ...timeBytes]);
    console.assert(t4 === 0x1A, `CRC test 4 failed: got 0x${t4.toString(16)}, expected 0x1A`);

    // Test 5: Response  →  55 0D 07 00 02 + "G1Etest" ascii  →  53
    const respBytes = [...Buffer.from('G1Etest', 'ascii')];
    const t5 = crc8([0x55, 0x0D, 0x07, 0x00, 0x02, ...respBytes]);
    console.assert(t5 === 0x53, `CRC test 5 failed: got 0x${t5.toString(16)}, expected 0x53`);

    // Test 6: buildCommandPacket — Get IP
    const pkt6 = buildCommandPacket(0x83, RW_GET);
    const expected6 = Buffer.from([0xAA, 0x06, 0x07, 0x00, 0x83, 0x50]);
    console.assert(pkt6.equals(expected6), `Packet build test 6 failed`);

    // Test 7: buildCommandPacket — Set IP
    const pkt7 = buildCommandPacket(0x83, RW_SET, Buffer.from('192.168.1.65', 'ascii'));
    const expected7 = Buffer.from([0xAA, 0x12, 0x07, 0x01, 0x83,
        0x31, 0x39, 0x32, 0x2E, 0x31, 0x36, 0x38, 0x2E, 0x31, 0x2E, 0x36, 0x35, 0xE8]);
    console.assert(pkt7.equals(expected7), `Packet build test 7 failed`);

    // Test 8: parseResponsePacket
    const respPkt = Buffer.from([0x55, 0x0D, 0x07, 0x00, 0x02,
        0x47, 0x31, 0x45, 0x74, 0x65, 0x73, 0x74, 0x53]);
    const parsed = parseResponsePacket(respPkt);
    console.assert(parsed !== null, 'Parse test 8 failed: null');
    console.assert(parsed!.rw === 0x00, `Parse test 8 rw failed`);
    console.assert(parsed!.status === 0x02, `Parse test 8 status failed`);
    // data now starts at byte4: [0x02, "G1Etest"], skip the leading type byte
    console.assert(parsed!.data.subarray(1).toString('ascii') === 'G1Etest', `Parse test 8 data failed`);
    console.assert(parsed!.data[0] === 0x02, `Parse test 8 data[0] failed`);

    console.log('All CRC-8 and packet tests passed.');
}

selfTest();
