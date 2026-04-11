param()

function Get-CRC32 {
    param([byte[]]$data)
    [uint32]$crc = 0xFFFFFFFF
    foreach ($byte in $data) {
        $crc = $crc -bxor [uint32]$byte
        for ($i = 0; $i -lt 8; $i++) {
            if ($crc -band 1) { $crc = 0xEDB88320 -bxor ($crc -shr 1) }
            else { $crc = $crc -shr 1 }
        }
    }
    return $crc -bxor 0xFFFFFFFF
}

function U32BE {
    param([uint32]$n)
    return [byte[]](($n -shr 24) -band 0xFF),(($n -shr 16) -band 0xFF),(($n -shr 8) -band 0xFF),($n -band 0xFF)
}

function Make-Chunk {
    param([string]$name, [byte[]]$data)
    $nb = [System.Text.Encoding]::ASCII.GetBytes($name)
    $len = U32BE([uint32]$data.Length)
    $crcInput = $nb + $data
    $crcVal = Get-CRC32 $crcInput
    $crcBytes = U32BE $crcVal
    return $len + $nb + $data + $crcBytes
}

function Make-PNG {
    param([int]$size, [byte]$r, [byte]$g, [byte]$b)

    $sig = [byte[]](137,80,78,71,13,10,26,10)

    # IHDR: width, height, bit depth=8, color type=2 (RGB), compression=0, filter=0, interlace=0
    $ihdrData = (U32BE $size) + (U32BE $size) + [byte[]](8,2,0,0,0)
    $ihdrChunk = Make-Chunk 'IHDR' $ihdrData

    # Build raw scanlines (filter byte 0 + RGB per pixel per row)
    $oneRow = [System.Collections.Generic.List[byte]]::new()
    $oneRow.Add(0) # filter none
    for ($i = 0; $i -lt $size; $i++) {
        $oneRow.Add($r); $oneRow.Add($g); $oneRow.Add($b)
    }
    $rawList = [System.Collections.Generic.List[byte]]::new()
    for ($y = 0; $y -lt $size; $y++) {
        $rawList.AddRange($oneRow.ToArray())
    }
    $rawBytes = $rawList.ToArray()

    # Compress with zlib (DeflateStream + zlib header/adler32)
    $deflateMs = [System.IO.MemoryStream]::new()
    $deflateStream = [System.IO.Compression.DeflateStream]::new($deflateMs, [System.IO.Compression.CompressionMode]::Compress)
    $deflateStream.Write($rawBytes, 0, $rawBytes.Length)
    $deflateStream.Close()
    $deflated = $deflateMs.ToArray()

    # Compute Adler-32
    [uint32]$s1 = 1; [uint32]$s2 = 0
    foreach ($byte in $rawBytes) {
        $s1 = ($s1 + $byte) % 65521
        $s2 = ($s2 + $s1) % 65521
    }
    $adler = ($s2 -shl 16) -bor $s1

    # zlib header: CMF=0x78 (deflate, window=32k), FLG chosen so CMF*256+FLG divisible by 31
    $cmf = [byte]0x78
    $flg = [byte]0x01
    $check = ($cmf * 256 + $flg) % 31
    if ($check -ne 0) { $flg = [byte]($flg + (31 - $check)) }
    $zlibData = [byte[]]($cmf, $flg) + $deflated + (U32BE $adler)

    $idatChunk = Make-Chunk 'IDAT' $zlibData
    $emptyBytes = [byte[]]@()
    $iendChunk = Make-Chunk 'IEND' $emptyBytes

    return $sig + $ihdrChunk + $idatChunk + $iendChunk
}

# Teams purple: #6264A7 = rgb(98, 100, 167)
$R = [byte]98; $G = [byte]100; $B = [byte]167

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($size in @(16, 48, 128)) {
    $png = Make-PNG $size $R $G $B
    $path = Join-Path $scriptDir "icon${size}.png"
    [System.IO.File]::WriteAllBytes($path, $png)
    Write-Host "Created icon${size}.png ($($png.Length) bytes)"
}
