import {
  type Addressee,
  assignParts,
  leadingAddressees,
  mentionedIn,
  namedIn,
  splitBlocks,
} from './addressedParts.js';
import { confidentYes, type Decider, tailOf } from './decisions.js';

/**
 * `addressedParts`, with a decision model as a second reader. The rule stays
 * first and final wherever it finds an opening `@name`. A block the rule gives
 * to nobody but that mentions someone later ("can you check the limits,
 * @scout?"), or names them without `@` ("scout, can you check…"), is asked
 * about: "is this a request to X?". Only a confident yes
 * addresses it; a failure or an unsure answer leaves the rule's result.
 */
export async function addressedPartsWithDecisions<K>(
  text: string,
  addressees: Array<Addressee<K>>,
  decider: Decider | null,
  nameOf: (key: K) => string,
  /** The agent whose reply this is (shown walking over to Laya). */
  senderId?: number,
): Promise<Map<K, string>> {
  const blocks = splitBlocks(text);
  const openers = blocks.map((block) => leadingAddressees(block, addressees));
  if (decider) {
    const asks: Array<Promise<void>> = [];
    blocks.forEach((block, i) => {
      if (openers[i].length > 0) return;
      // `@name` later in the block, or the bare name ("scout, can you…").
      const candidates = [
        ...new Set([...mentionedIn(block, addressees), ...namedIn(block, addressees)]),
      ];
      if (candidates.length === 0) return;
      asks.push(
        decider
          .ask(
            { paragraph: tailOf(block) },
            Object.fromEntries(
              candidates.map((key, n) => [
                `to${n}`,
                {
                  type: 'noul' as const,
                  instructions: `Does this paragraph ask @${nameOf(key)} to do something or to answer a question? A status note or a plan that only names them is not a request.`,
                },
              ]),
            ),
            { agentId: senderId, topic: 'Who is this for?' },
          )
          .then((answers) => {
            if (!answers) return;
            openers[i] = candidates.filter(
              (_, n) => confidentYes(answers[`to${n}`], 'addressed') === true,
            );
          }),
      );
    });
    await Promise.all(asks);
  }
  return assignParts(blocks, openers);
}
