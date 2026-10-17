import Foundation
import AppKit
import Security
import Darwin

// No logging, no arguments containing secrets, no synchronizable Keychain item.
func main() throws {
    guard let r = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: String], let action = r["action"] else { throw NSError(domain: "input", code: 1) }
    if action == "watch" {
        let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
            FileHandle.standardOutput.write(Data("{\"event\":\"resume\"}\n".utf8))
        }
        withExtendedLifetime(observer) { RunLoop.main.run() }
        return
    }
    if action == "clock" {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let seconds = Double(mach_continuous_time()) * Double(info.numer) / Double(info.denom) / 1_000_000_000
        let data = try JSONSerialization.data(withJSONObject: ["seconds": seconds])
        FileHandle.standardOutput.write(data)
        return
    }
    guard let account = r["account"], !account.isEmpty else { throw NSError(domain: "input", code: 1) }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ProjectHub.DeviceKey.v1", kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    if action == "put" {
        guard let value = r["value"] else { throw NSError(domain: "input", code: 1) }
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        // Never overwrite a pre-existing identity.
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw NSError(domain: "keychain", code: 1) }
        FileHandle.standardOutput.write(Data("{}".utf8))
    } else if action == "get" {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { FileHandle.standardOutput.write(Data("{\"value\":null}".utf8)); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw NSError(domain: "keychain", code: 1) }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["value": value]))
    } else { throw NSError(domain: "input", code: 1) }
}
do { try main() } catch { exit(1) }
