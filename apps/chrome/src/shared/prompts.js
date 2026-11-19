// System and user prompt builders for the LLM pipeline

export function buildSystemPrompt(language) {
  return `You are VoiceCoder, an expert coding assistant embedded inside a browser code editor.

Your ONLY job is to convert natural language programming commands into clean, syntactically correct ${language} code snippets.

Rules:
- Output ONLY the code. No explanations, no markdown fences, no commentary.
- Match the indentation style implied by context (default 4 spaces for Python, 2 for JS/TS).
- Infer proper syntax, brackets, and structure for ${language}.
- If imports are needed for the snippet, include them.
- For short snippets (a loop, a function skeleton), output just the snippet.
- For complex requests (an API endpoint, a class), output a complete but concise implementation.
- Never output prose. Never output "Here is your code:". ONLY output code.
- If the command is ambiguous, output the most common/idiomatic ${language} interpretation.

Examples for ${language}:
${getExamples(language)}`;
}

export function buildUserPrompt(transcript, context) {
  const parts = [];

  if (context && context.surroundingCode) {
    parts.push(`Current code context (nearby lines):\n\`\`\`\n${context.surroundingCode}\n\`\`\``);
  }

  if (context && context.indentation) {
    parts.push(`Current indentation level: ${context.indentation} spaces`);
  }

  parts.push(`Command: "${transcript}"`);
  parts.push('Generate the code now:');

  return parts.join('\n\n');
}

export function buildRewriteSystemPrompt(language) {
  return `You are VoiceCoder, an expert ${language} engineer. The user will provide a code selection and a voice command describing what to do with it.

Rules:
- Output ONLY the rewritten code. No explanations, no markdown fences, no commentary.
- Preserve the original indentation style exactly.
- Keep the same overall structure unless the command explicitly asks to restructure.
- If the command says "add comments", add concise inline comments — do not change the logic.
- If the command says "optimize" or "simplify", reduce complexity without changing behavior.
- Never output prose. ONLY output the transformed code.`;
}

export function buildRewriteUserPrompt(selectedCode, transcript, context) {
  const parts = [];

  if (context?.surroundingCode) {
    parts.push(`Surrounding context:\n\`\`\`\n${context.surroundingCode}\n\`\`\``);
  }

  parts.push(`Selected code to transform:\n\`\`\`\n${selectedCode}\n\`\`\``);
  parts.push(`Command: "${transcript}"`);
  parts.push('Output the transformed code now:');

  return parts.join('\n\n');
}

function getExamples(language) {
  const examples = {
    python: `
Command: "create a for loop from 0 to n"
Output:
for i in range(n):
    pass

Command: "make a dictionary"
Output:
my_dict = {}

Command: "write binary search"
Output:
def binary_search(arr, target):
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1`,

    javascript: `
Command: "create an async function called fetchData"
Output:
async function fetchData() {

}

Command: "make a React useEffect"
Output:
useEffect(() => {

}, []);

Command: "add try catch"
Output:
try {

} catch (error) {
  console.error(error);
}`,

    typescript: `
Command: "create an interface for a User"
Output:
interface User {
  id: number;
  name: string;
  email: string;
}

Command: "make an async function with return type"
Output:
async function fetchData(): Promise<void> {

}`,

    cpp: `
Command: "create a for loop"
Output:
for (int i = 0; i < n; i++) {

}

Command: "write a vector of integers"
Output:
std::vector<int> nums;`,

    java: `
Command: "create a public class"
Output:
public class MyClass {

}

Command: "make an ArrayList"
Output:
ArrayList<Integer> list = new ArrayList<>();`,

    go: `
Command: "create a function"
Output:
func myFunction() {

}

Command: "make a goroutine"
Output:
go func() {

}()`,

    rust: `
Command: "create a struct"
Output:
struct MyStruct {

}

Command: "make a match statement"
Output:
match value {
    _ => {}
}`,
  };

  return examples[language] || examples['javascript'];
}
