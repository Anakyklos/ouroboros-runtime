import type { HashlineEdit } from "../domain/hashline/types";

export interface IHashlineEdit {
  /**
   * Reads a file and returns its content formatted with LINE#ID anchors.
   * This is essential for agents to get the current state and hash anchors before editing.
   * 
   * @param filePath The absolute path to the file.
   * @returns The file content with each line prefixed by "LINE#ID:".
   */
  read(filePath: string): Promise<string>;

  /**
   * Applies a set of edits to a file, validating hash anchors.
   * 
   * @param filePath The absolute path to the file.
   * @param edits An array of HashlineEdit operations (set_line, replace_lines, insert_after, replace).
   * @returns A summary of the applied edits or the new file content.
   * @throws Error if file not found or hash mismatch occurs.
   */
  edit(filePath: string, edits: HashlineEdit[]): Promise<string>;
}
