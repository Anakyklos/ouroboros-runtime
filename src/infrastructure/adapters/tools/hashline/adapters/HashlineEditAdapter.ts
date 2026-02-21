import type { IHashlineEdit } from "../ports/IHashlineEdit";
import type { HashlineEdit } from "../domain/hashline/types";
import { applyHashlineEdits } from "../domain/hashline/edit-operations";
import { toHashlineContent } from "../domain/hashline/diff-utils";

export class HashlineEditAdapter implements IHashlineEdit {
  async read(filePath: string): Promise<string> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`);
    }
    const content = await file.text();
    return toHashlineContent(content);
  }

  async edit(filePath: string, edits: HashlineEdit[]): Promise<string> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`);
    }

    const oldContent = await file.text();
    // Validate that edits is an array and not empty
    if (!edits || !Array.isArray(edits) || edits.length === 0) {
       throw new Error("edits parameter must be a non-empty array");
    }

    const newContent = applyHashlineEdits(oldContent, edits);

    await Bun.write(filePath, newContent);
    return toHashlineContent(newContent);
  }
}
