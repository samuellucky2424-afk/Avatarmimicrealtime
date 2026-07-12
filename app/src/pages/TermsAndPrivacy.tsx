import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { BrandIcon } from '@/components/BrandIcon';

const sections = [
  ['1. Eligibility and acceptance', 'You must be at least 13 years old to use Avatar Mimic Real Time. If you are a minor, a parent or legal guardian must permit your use. By creating an account, downloading the application, or using the service, you agree to these terms.'],
  ['2. Service and generated content', 'The service lets you submit prompts, images, video, audio, and other input to create real-time generated output. You are responsible for your input and your use of any output. Generated results may be inaccurate, may not be unique, and must be reviewed before you rely on them.'],
  ['3. Acceptable use', 'Do not use the service for unlawful, harmful, abusive, deceptive, infringing, or privacy-invasive activity. You must have the rights and permissions needed for every person, image, recording, prompt, and other material you submit. Do not bypass security, disrupt the service, scrape it, reverse engineer it, or use it to violate another person’s rights.'],
  ['4. Accounts and security', 'Provide accurate account information, protect your password, and promptly report suspected unauthorized access. You are responsible for activity performed through your account. We may suspend or terminate accounts that violate these terms, applicable law, or safety requirements.'],
  ['5. Credits and purchases', 'Some features require credits. The price and number of credits are shown before purchase. Unless applicable law requires otherwise, purchased credits are non-refundable and may be subject to the validity period displayed at purchase. Access may be limited when payment is incomplete or these terms are breached.'],
  ['6. Ownership and permissions', 'You retain ownership of your original input. Subject to these terms and third-party rights, you may use generated output for lawful purposes. You grant us the limited rights needed to process your input, operate the service, provide support, maintain security, and improve reliability.'],
  ['7. Third-party services', 'The application may rely on third-party hosting, authentication, artificial-intelligence, messaging, and infrastructure providers. Their services may have separate terms. We do not control third-party availability, content, or policies.'],
  ['8. Availability and changes', 'Features may change, be interrupted, or be discontinued. We may update these terms and will make the revised version available in the application. Continued use after an update takes effect means you accept the revised terms.'],
  ['9. Disclaimers and liability', 'The service is provided on an “as available” basis to the maximum extent permitted by law. We do not guarantee uninterrupted operation, error-free output, or suitability for a particular purpose. Liability is limited to the extent permitted by applicable law.'],
  ['10. Termination and governing terms', 'You may stop using the service at any time. Provisions that by their nature should survive termination will remain effective. Disputes and mandatory consumer rights are governed by the laws applicable to your location and the service operator.'],
];

const privacySections = [
  ['Information we collect', 'We process account details such as your name and email, service activity, device and diagnostic data, wallet and transaction records, support messages, and the content you choose to submit for real-time processing.'],
  ['How information is used', 'Information is used to authenticate you, provide streaming and generation features, maintain balances, process support and purchase requests, prevent abuse, secure the service, diagnose failures, and meet legal obligations.'],
  ['Content processing', 'Camera, image, prompt, audio, and video content is transmitted only when you start or use the relevant feature. Content may be processed by contracted infrastructure and AI providers to produce the requested result. Do not submit content you are not authorized to process.'],
  ['Sharing', 'We share information only with service providers needed to operate the application, when you direct us to do so, to complete a transaction or support request, or when disclosure is required for security or by law. We do not sell your personal information.'],
  ['Retention and security', 'We retain information for as long as needed to provide the service, maintain required records, resolve disputes, and comply with law. We use reasonable technical and organizational safeguards, but no online system can guarantee absolute security.'],
  ['Your choices and rights', 'You may request access, correction, or deletion of your account information, subject to legal and operational retention requirements. You can stop camera and microphone access through the application or Windows permissions and may stop using the service at any time.'],
  ['Children', 'The service is not intended for children under 13. We do not knowingly collect personal information from children under 13.'],
  ['Policy changes', 'We may revise this notice as the service changes. The current version and its effective date will remain available on this page.'],
];

function PolicySection({ title, text }: { title: string; text: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="text-sm leading-6 text-[#a1a1aa]">{text}</p>
    </section>
  );
}

export default function TermsAndPrivacy() {
  return (
    <main className="min-h-screen bg-[#09090b] px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link to="/login" className="inline-flex items-center gap-2 text-sm text-[#a1a1aa] hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div className="flex items-center gap-2">
            <BrandIcon className="h-8 w-8 rounded-lg" />
            <span className="text-sm font-semibold">Avatar Mimic Real Time</span>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-[#27272a] bg-[#0f0f10]">
          <header className="border-b border-[#27272a] p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-7 w-7 text-blue-400" />
              <div>
                <h1 className="text-2xl font-semibold">Terms &amp; Privacy</h1>
                <p className="mt-1 text-sm text-[#71717a]">Effective June 8, 2026</p>
              </div>
            </div>
          </header>

          <div className="space-y-10 p-6 sm:p-8">
            <article className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold">Terms of Service</h2>
                <p className="mt-2 text-sm leading-6 text-[#a1a1aa]">Please read these terms before using the application. If you do not agree, do not access or use the service.</p>
              </div>
              {sections.map(([title, text]) => <PolicySection key={title} title={title} text={text} />)}
            </article>

            <div className="h-px bg-[#27272a]" />

            <article className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold">Privacy Policy</h2>
                <p className="mt-2 text-sm leading-6 text-[#a1a1aa]">This notice explains how personal information is handled when you use Avatar Mimic Real Time.</p>
              </div>
              {privacySections.map(([title, text]) => <PolicySection key={title} title={title} text={text} />)}
            </article>
          </div>
        </div>
      </div>
    </main>
  );
}
