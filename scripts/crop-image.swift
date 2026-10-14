// One-off asset helper: crops a rectangle out of a PNG so design screens in
// /Assets can be reused as web assets. No third-party dependencies (AppKit).
//
// Usage: swift scripts/crop-image.swift <src> <dst> <x> <y> <w> <h>
import AppKit

let args = CommandLine.arguments
guard args.count == 7,
      let x = Int(args[3]), let y = Int(args[4]),
      let w = Int(args[5]), let h = Int(args[6]),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let rep = NSBitmapImageRep(data: data) else {
    FileHandle.standardError.write("usage: crop-image.swift <src> <dst> <x> <y> <w> <h>\n".data(using: .utf8)!)
    exit(1)
}

let srcW = rep.pixelsWide, srcH = rep.pixelsHigh
guard x >= 0, y >= 0, w > 0, h > 0, x + w <= srcW, y + h <= srcH else {
    FileHandle.standardError.write("crop \(w)x\(h)+\(x)+\(y) outside \(srcW)x\(srcH)\n".data(using: .utf8)!)
    exit(1)
}

guard let crop = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: w,
    pixelsHigh: h,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else { exit(1) }
crop.size = NSSize(width: CGFloat(w), height: CGFloat(h))

// NSBitmapImageRep drawing is bottom-left origin; flip the y offset.
let srcRect = NSRect(x: CGFloat(x), y: CGFloat(srcH - y - h), width: CGFloat(w), height: CGFloat(h))
let dstRect = NSRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h))
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: crop)
rep.draw(in: dstRect, from: srcRect, operation: .copy, fraction: 1.0,
         respectFlipped: true, hints: nil)
NSGraphicsContext.restoreGraphicsState()

guard let png = crop.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: args[2]))
print("ok \(srcW)x\(srcH) -> \(w)x\(h) at (\(x),\(y))")
