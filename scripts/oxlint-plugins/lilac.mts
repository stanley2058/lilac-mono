import { definePlugin } from "@oxlint/plugins";

import {
  blobStorageSeamRule,
  noElseAfterTerminalRule,
  noExceptionFlowRule,
  noDirectSqliteTransactionRule,
  noInlineAsyncResultCallbackRule,
  noLocalIsRecordRule,
  noPresentationDecoderImportRule,
  noRedundantBranchRule,
  noStoreInlineDecodingRule,
  preferSwitchTrueChainRule,
} from "./production-syntax.mts";
import { noFixedTestWaitRule } from "./test-waits.mts";

export default definePlugin({
  meta: { name: "lilac" },
  rules: {
    "blob-storage-seam": blobStorageSeamRule,
    "no-else-after-terminal": noElseAfterTerminalRule,
    "no-exception-flow": noExceptionFlowRule,
    "no-direct-sqlite-transaction": noDirectSqliteTransactionRule,
    "no-fixed-test-wait": noFixedTestWaitRule,
    "no-inline-async-result-callback": noInlineAsyncResultCallbackRule,
    "no-local-is-record": noLocalIsRecordRule,
    "no-presentation-decoder-import": noPresentationDecoderImportRule,
    "no-redundant-branch": noRedundantBranchRule,
    "no-store-inline-decoding": noStoreInlineDecodingRule,
    "prefer-switch-true-chain": preferSwitchTrueChainRule,
  },
});
