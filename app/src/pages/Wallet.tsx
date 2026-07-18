import { ArrowDownLeft, ArrowUpRight, Coins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { formatCreditMinutes } from '@/lib/billing';

function Wallet() {
  const { credits, transactions } = useApp();
  const navigate = useNavigate();

  return (
    <div className="max-w-[800px]">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Wallet</h1>
        <p className="text-sm text-[#a1a1aa]">Manage your streaming minutes and view transactions</p>
      </div>

      <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20 mb-6">
        <CardHeader className="pb-4 border-b border-[#1f1f23]">
          <CardTitle className="text-sm font-medium text-[#71717a]">Available Streaming Time</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Coins className="w-6 h-6 text-blue-400" />
            </div>
            <div>
              <p className="text-4xl font-semibold text-white">{formatCreditMinutes(credits)}</p>
              <p className="text-sm text-[#71717a]">remaining</p>
            </div>
          </div>
          <div className="bg-[#1a1a1f] rounded-lg p-4 border border-[#27272a]">
            <p className="text-sm text-[#a1a1aa]">
              Remaining stream time: <span className="text-white font-semibold">{formatCreditMinutes(credits)}</span>
            </p>
          </div>
          <Button 
            onClick={() => navigate('/settings')}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Recharge
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
        <CardHeader className="pb-4 border-b border-[#1f1f23]">
          <CardTitle className="text-sm font-medium text-[#71717a]">Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <div className="text-center py-8 text-[#71717a]">
              No transactions found.
            </div>
          ) : (
            <div className="space-y-4 pt-4">
              {transactions.map((tx, index) => (
                <div key={tx.id}>
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${tx.type === 'credit' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                        {tx.type === 'credit' ? (
                          <ArrowDownLeft className="w-5 h-5 text-emerald-500" />
                        ) : (
                          <ArrowUpRight className="w-5 h-5 text-red-500" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          {tx.description?.replace(/credits?/gi, 'minutes') || (tx.type === 'credit' ? 'Minutes purchased' : 'Stream usage')}
                        </p>
                        <p className="text-xs text-[#71717a]">
                          {new Date(tx.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${tx.type === 'credit' ? 'text-emerald-500' : 'text-red-500'}`}>
                        {tx.type === 'debit' ? '-' : '+'}{formatCreditMinutes(tx.credits || 0)}
                      </p>
                      <p className="text-xs text-[#71717a]">Completed</p>
                    </div>
                  </div>
                  {index < transactions.length - 1 && <Separator className="bg-[#27272a]" />}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Wallet;
