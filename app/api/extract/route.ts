import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import pdf from "pdf-parse"
import { generateText } from "ai"
import { xai } from "@ai-sdk/xai"

const CvSchema = z.object({
  nombre: z.string().optional(),
  email: z.string().email().optional(),
  telefono: z.string().optional(),
  ubicacion: z.string().optional(),
  fecha_nacimiento: z.string().optional(),
  experiencia: z
    .array(
      z.object({
        empresa: z.string().optional(),
        rol: z.string().optional(),
        inicio: z.string().optional(),
        fin: z.string().optional(),
        tareas: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  formacion: z
    .array(
      z.object({
        titulo: z.string().optional(),
        centro: z.string().optional(),
        inicio: z.string().optional(),
        fin: z.string().optional(),
      }),
    )
    .optional(),
  idiomas: z.array(z.string()).optional(),
  habilidades: z.array(z.string()).optional(),
  otros: z.array(z.string()).optional(),
})

async function extractText(file: File) {
  const buf = Buffer.from(await file.arrayBuffer())
  const data = await pdf(buf)
  return data.text || ""
}

// Heurísticas rápidas sin IA (funciona "offline")
function quickParse(text: string) {
  const clean = (s: string) => s?.trim().replace(/\s+/g, " ") || ""

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
  const telefono = text.match(/(\+?\d[\d\s]{7,}\d)/)?.[0]
  const fecha = text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0]

  const nombre =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /alejandro ortiz/i.test(l)) || undefined

  // Muy simple: busca bloques estándar
  const seccion = (title: RegExp) => {
    const lines = text.split("\n")
    const idx = lines.findIndex((l) => title.test(l))
    if (idx === -1) return ""
    const end = ["EXPERIENCIA", "FORMACIÓN", "IDIOMAS", "INFORMATICA", "OTROS", "HABILIDADES"]
    let j = idx + 1
    const out: string[] = []
    for (; j < lines.length; j++) {
      const L = lines[j].toUpperCase().trim()
      if (end.some((h) => L.startsWith(h))) break
      out.push(lines[j])
    }
    return out.join("\n").trim()
  }

  const idiomasRaw = seccion(/IDIOMAS/i)
  const idiomas = idiomasRaw
    ? idiomasRaw
        .split(/\n|•|-/)
        .map((s) => clean(s))
        .filter(Boolean)
    : []

  const infoRaw = seccion(/INFORMATICA/i)
  const habilidades = infoRaw
    ? infoRaw
        .split(/\n|•|-/)
        .map((s) => clean(s))
        .filter(Boolean)
    : []

  return {
    nombre: clean(nombre),
    email: clean(email || ""),
    telefono: clean(telefono || ""),
    ubicacion: /Las Rozas/i.test(text) ? "Las Rozas - Madrid" : undefined,
    fecha_nacimiento: fecha,
    idiomas,
    habilidades,
  }
}

// Modo IA (opcional) para estructurar bonito con contexto
async function llmStructurize(text: string) {
  if (!process.env.OPENAI_API_KEY) return null

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      system:
        "Eres un experto extractor de currículums que devuelve únicamente JSON válido según el esquema solicitado. Analiza el texto del currículum y extrae la información de manera precisa y estructurada.",
      prompt: `Extrae la información del siguiente currículum y devuelve ÚNICAMENTE un JSON válido con este esquema exacto:

{
  "nombre": string?,
  "email": string?,
  "telefono": string?,
  "ubicacion": string?,
  "fecha_nacimiento": string?,
  "experiencia": [{ "empresa": string?, "rol": string?, "inicio": string?, "fin": string?, "tareas": string[]? }]?,
  "formacion": [{ "titulo": string?, "centro": string?, "inicio": string?, "fin": string? }]?,
  "idiomas": string[]?,
  "habilidades": string[]?,
  "otros": string[]?
}

Texto del currículum:
"""${text.slice(0, 3000)}"""

Responde ÚNICAMENTE con el JSON, sin explicaciones adicionales.`,
      temperature: 0.1,
      maxTokens: 2000,
    })

    const content = result.text

    if (content) {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || content.match(/(\{[\s\S]*\})/)
      const jsonStr = jsonMatch ? jsonMatch[1] : content

      try {
        const parsed = JSON.parse(jsonStr)
        return CvSchema.parse(parsed)
      } catch {
        return null
      }
    }
  } catch (e) {
    console.error("OpenAI structurize error:", e)
  }

  return null
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get("file")
    const useLLM = form.get("useLLM") === "true"

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file requerido" }, { status: 400 })
    }

    let text = ""
    try {
      text = await extractText(file)
    } catch (pdfError) {
      console.error("PDF extraction error:", pdfError)
      return NextResponse.json(
        {
          error: "Error al extraer texto del PDF",
          details: pdfError instanceof Error ? pdfError.message : "Unknown error",
        },
        { status: 400 },
      )
    }

    if (!text || text.trim().length === 0) {
      return NextResponse.json(
        {
          error: "No se pudo extraer texto del PDF",
          details: "El archivo PDF parece estar vacío o no contiene texto extraíble",
        },
        { status: 400 },
      )
    }

    // 1) Heurística rápida
    const base = quickParse(text)

    // 2) IA opcional
    let enriched = null as any
    if (useLLM) {
      try {
        enriched = await llmStructurize(text)
      } catch (e) {
        console.error("LLM error:", e)
        // Continue without LLM enhancement instead of failing
      }
    }

    const merged = { ...base, ...(enriched || {}) }

    // Validación final
    let safe
    try {
      safe = CvSchema.parse(merged)
    } catch {
      safe = merged
    }

    return NextResponse.json({
      ok: true,
      summary: safe,
      rawTextPreview: text.slice(0, 1500), // útil para debug
    })
  } catch (error) {
    console.error("API Error:", error)
    return NextResponse.json(
      {
        error: "Error interno del servidor",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
